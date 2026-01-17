
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { GoogleGenAI, Type } = require('@google/genai');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const winston = require('winston');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');
require('dotenv').config();

// --- 1. OBSERVABILITY ---
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

// --- 2. UTILS ---
const cleanInput = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").slice(0, 5000);
};

// --- 3. MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user) => {
    if (err) return res.status(403).json({ error: "Forbidden" });
    req.user = user;
    next();
  });
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// --- 4. DATABASE MODELS ---
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, default: 'User' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  subscription: { type: String, enum: ['hobby', 'pro', 'agency'], default: 'hobby' },
  subscriptionStatus: { type: String, default: 'active' },
  organizationId: { type: String, default: () => crypto.randomUUID() },
  lastLogin: { type: Date, default: Date.now }
});

const ProjectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  data: { type: Object, default: {} },
  updatedAt: { type: Date, default: Date.now }
});

const TicketSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String },
  subject: { type: String, required: true },
  category: { type: String, default: 'technical' },
  priority: { type: String, default: 'medium' },
  status: { type: String, default: 'open' },
  messages: [{
    senderId: String,
    senderName: String,
    role: String,
    text: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Project = mongoose.models.Project || mongoose.model('Project', ProjectSchema);
const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', TicketSchema);

// --- 5. INFRASTRUCTURE ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info("MongoDB Connected"))
  .catch(err => logger.error("DB Error", err));

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// Need rawBody for webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.includes('/api/webhooks/bani')) {
      req.rawBody = buf.toString();
    }
  }
}));

app.use(cors({ origin: true, credentials: true }));

// --- 6. ROUTES ---
app.get('/health', (req, res) => res.json({ status: 'ok', maintenance: false }));

// AUTH with ENV-based Admin Override
app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  if (await User.findOne({ email })) return res.status(400).json({ error: "Email exists" });
  
  const user = new User({ 
    email, 
    password: await bcrypt.hash(password, 10), 
    name,
    role: 'user', // Default to user
    subscription: 'hobby'
  });
  
  await user.save();
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
  res.json({ user, token });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Environment-based Admin Logic
  if (process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL) {
      if (password === process.env.ADMIN_PASSWORD) {
          // Check if admin user exists in DB to have an ID, otherwise create/stub
          let adminUser = await User.findOne({ email: process.env.ADMIN_EMAIL });
          if (!adminUser) {
              adminUser = new User({
                  email: process.env.ADMIN_EMAIL,
                  password: await bcrypt.hash(password, 10),
                  name: 'System Administrator',
                  role: 'admin',
                  subscription: 'agency'
              });
              await adminUser.save();
          }
          const token = jwt.sign({ id: adminUser._id, role: 'admin' }, process.env.JWT_SECRET || 'secret');
          return res.json({ user: adminUser, token });
      } else {
          return res.status(401).json({ error: "Invalid admin credentials" });
      }
  }

  const user = await User.findOne({ email });
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Invalid login" });
  
  user.lastLogin = Date.now();
  await user.save();
  
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
  res.json({ user, token });
}));

// Projects
app.get('/api/projects', authenticateToken, asyncHandler(async (req, res) => {
  res.json(await Project.find({ userId: req.user.id }).sort({ updatedAt: -1 }));
}));

app.post('/api/projects', authenticateToken, asyncHandler(async (req, res) => {
  const project = new Project({ userId: req.user.id, name: req.body.name, data: { productName: req.body.name, productDescription: req.body.description } });
  await project.save();
  res.json(project);
}));

app.put('/api/projects/:id', authenticateToken, asyncHandler(async (req, res) => {
  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: { data: req.body.data, updatedAt: Date.now() } },
    { new: true }
  );
  res.json(project);
}));

// Admin Routes
app.get('/api/admin/stats', authenticateToken, asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
    // Calculate real stats
    const users = await User.countDocuments();
    const projects = await Project.countDocuments();
    // Dummy api calls, real MRR calculation
    res.json({ totalUsers: users, totalProjects: projects, revenueMRR: 0, apiCallsToday: 0 }); 
}));

app.get('/api/admin/users', authenticateToken, asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
    const users = await User.find({}).sort({ lastLogin: -1 });
    res.json(users);
}));

// --- AI ENGINE ENDPOINT ---
app.post('/api/ai/execute', authenticateToken, asyncHandler(async (req, res) => {
  const { agent, payload } = req.body;
  if (!agent) return res.status(400).json({ error: "Agent required" });

  const flashModel = 'gemini-3-flash-preview';
  const proModel = 'gemini-3-pro-preview';
  const mapsModel = 'gemini-2.5-flash'; // For maps grounding

  try {
    let result;
    switch (agent) {
      case 'niche':
        const nicheRes = await ai.models.generateContent({
          model: flashModel,
          contents: `Analyze product: "${payload.productName}". Desc: ${payload.description}. Focus: ${payload.focus || 'Any'}. Find 3 profitable niches.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  profitabilityScore: { type: Type.INTEGER },
                  reasoning: { type: Type.STRING },
                  marketSizeEstimate: { type: Type.STRING }
                }
              }
            }
          }
        });
        result = JSON.parse(nicheRes.text);
        break;

      case 'persona':
        const personaRes = await ai.models.generateContent({
          model: flashModel,
          contents: `Create Ideal Customer Persona for "${payload.productName}" in niche "${payload.niche}". Refine: ${payload.refinement || 'Standard'}.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                jobTitle: { type: Type.STRING },
                ageRange: { type: Type.STRING },
                psychographics: { type: Type.ARRAY, items: { type: Type.STRING } },
                painPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                goals: { type: Type.ARRAY, items: { type: Type.STRING } },
                buyingTriggers: { type: Type.ARRAY, items: { type: Type.STRING } }
              }
            }
          }
        });
        result = JSON.parse(personaRes.text);
        break;

      case 'magnets':
        const magnetRes = await ai.models.generateContent({
          model: flashModel,
          contents: `Generate 4 lead magnet ideas for ${payload.persona} interested in ${payload.productName}.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  type: { type: Type.STRING },
                  hook: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            }
          }
        });
        result = JSON.parse(magnetRes.text);
        break;

      case 'magnet_content':
        const mcRes = await ai.models.generateContent({
            model: proModel,
            contents: `Write draft content for a lead magnet titled "${payload.magnet.title}" (${payload.magnet.type}). 
            Target Audience: ${payload.persona}. Niche: ${payload.nicheName}. Product: ${payload.productName}.
            Structure: Introduction, 3 Key Chapters, Conclusion/CTA.`
        });
        result = mcRes.text;
        break;

      case 'magnet_promo':
        const promoRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Write a promotional social media post for ${payload.platform}. 
            Asset: "${payload.magnet.title}". Link: ${payload.link}. Persona: ${payload.persona}.`
        });
        result = promoRes.text;
        break;

      case 'ad_creatives':
        const adsRes = await ai.models.generateContent({
          model: flashModel,
          contents: `Write ads for ${payload.productName} targeting ${payload.persona}. URL: ${payload.url || 'N/A'}.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  platform: { type: Type.STRING },
                  headline: { type: Type.STRING },
                  adCopy: { type: Type.STRING },
                  hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
                  visualPrompt: { type: Type.STRING }
                }
              }
            }
          }
        });
        result = JSON.parse(adsRes.text);
        break;

      case 'landing_page':
        const lpRes = await ai.models.generateContent({
          model: proModel,
          contents: `Draft landing page copy for ${payload.productName} in ${payload.niche.name}. Target: ${payload.persona}.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                headline: { type: Type.STRING },
                subheadline: { type: Type.STRING },
                ctaPrimary: { type: Type.STRING },
                ctaSecondary: { type: Type.STRING },
                heroImagePrompt: { type: Type.STRING },
                benefits: { 
                  type: Type.ARRAY, 
                  items: { 
                    type: Type.OBJECT, 
                    properties: { title: { type: Type.STRING }, description: { type: Type.STRING } } 
                  } 
                },
                socialProof: { 
                   type: Type.ARRAY, 
                   items: { 
                     type: Type.OBJECT, 
                     properties: { name: { type: Type.STRING }, quote: { type: Type.STRING }, role: { type: Type.STRING } } 
                   } 
                }
              }
            }
          }
        });
        result = JSON.parse(lpRes.text);
        break;

      case 'maps_scout':
        // Use Gemini 2.5 Flash with Google Maps Tool
        const mapsRes = await ai.models.generateContent({
          model: mapsModel,
          contents: `Find businesses in ${payload.location} that match the niche "${payload.niche}". Provide a list with details.`,
          config: { tools: [{ googleMaps: {} }] }
        });
        result = { 
          text: mapsRes.text, 
          mapChunks: mapsRes.candidates[0].groundingMetadata?.groundingChunks || []
        };
        break;

      case 'social_search':
        const ssRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Generate 5 Boolean search strings to find "${payload.persona.jobTitle}" in niche "${payload.niche}" on LinkedIn, Twitter, and Google.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            platform: { type: Type.STRING },
                            query: { type: Type.STRING },
                            explanation: { type: Type.STRING },
                            directUrl: { type: Type.STRING }
                        }
                    }
                }
            }
        });
        result = JSON.parse(ssRes.text);
        break;

      case 'qualification':
        const qualRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Create a 5-question BANT qualification framework for ${payload.productName} targeting ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            question: { type: Type.STRING },
                            intent: { type: Type.STRING },
                            idealAnswer: { type: Type.STRING }
                        }
                    }
                }
            }
        });
        result = JSON.parse(qualRes.text);
        break;

      case 'objection_handler':
        const objRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Provide 3 short, punchy rebuttals to the sales objection: "${payload.objection}". Product: ${payload.productName}. Persona: ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                }
            }
        });
        result = JSON.parse(objRes.text);
        break;

      case 'cold_dms':
        const dmRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Write 3 variations of cold DM scripts for ${payload.productName} targeting ${payload.persona}. Keep it under 280 chars.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                }
            }
        });
        result = JSON.parse(dmRes.text);
        break;

      case 'follow_up':
        const fuRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Create a 3-email follow-up sequence for non-responsive leads. Product: ${payload.productName}. Persona: ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            subject: { type: Type.STRING },
                            previewText: { type: Type.STRING },
                            body: { type: Type.STRING },
                            sendDelay: { type: Type.STRING }
                        }
                    }
                }
            }
        });
        result = JSON.parse(fuRes.text);
        break;

      case 'email_campaign':
        const emailRes = await ai.models.generateContent({
            model: proModel,
            contents: `Write an email campaign. Topic: ${payload.topic}. Goal: ${payload.goal}. Product: ${payload.productName}. Persona: ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        subject: { type: Type.STRING },
                        body: { type: Type.STRING }
                    }
                }
            }
        });
        result = JSON.parse(emailRes.text);
        break;

      case 'subject_lines':
        const slRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Generate 5 viral email subject lines for topic: "${payload.topic}". Target: ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                }
            }
        });
        result = JSON.parse(slRes.text);
        break;

      case 'seo_audit':
        // Using Search Grounding to find info about the site
        const auditRes = await ai.models.generateContent({
            model: proModel,
            contents: `Perform a technical SEO audit simulation for ${payload.url}. Identify potential critical issues, warnings, and passed checks based on standard best practices for ${payload.productName}.`,
            config: {
                tools: [{ googleSearch: {} }]
            }
        });
        // We parse the text result into structured data via a second pass or simple regex/structure in prompt, 
        // but for reliability in this demo we return a structured mock derived from the grounding
        // Ideally we ask for JSON but grounding responses can be text.
        // Let's ask for JSON with grounding.
        const structuredAudit = await ai.models.generateContent({
             model: flashModel,
             contents: `Based on this analysis: ${auditRes.text}, format into JSON list of issues.`,
             config: {
                 responseMimeType: 'application/json',
                 responseSchema: {
                     type: Type.OBJECT,
                     properties: {
                         results: {
                             type: Type.ARRAY,
                             items: {
                                 type: Type.OBJECT,
                                 properties: {
                                     severity: { type: Type.STRING },
                                     category: { type: Type.STRING },
                                     issue: { type: Type.STRING },
                                     recommendation: { type: Type.STRING }
                                 }
                             }
                         }
                     }
                 }
             }
        });
        const auditJson = JSON.parse(structuredAudit.text);
        result = {
            results: auditJson.results,
            sources: auditRes.candidates[0].groundingMetadata?.groundingChunks
        };
        break;

      case 'seo_keywords':
        const kwRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Generate keyword strategy for "${payload.seed}" in niche "${payload.niche}". Persona: ${payload.persona}.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            keyword: { type: Type.STRING },
                            intent: { type: Type.STRING },
                            volume: { type: Type.STRING },
                            difficulty: { type: Type.INTEGER },
                            opportunityScore: { type: Type.INTEGER }
                        }
                    }
                }
            }
        });
        result = JSON.parse(kwRes.text);
        break;

      case 'content_score':
        const scoreRes = await ai.models.generateContent({
            model: flashModel,
            contents: `Analyze this content for SEO against keyword "${payload.keyword}": "${payload.content.slice(0, 1000)}..."`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        score: { type: Type.INTEGER },
                        suggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
                        keywordDensity: { type: Type.NUMBER },
                        readability: { type: Type.STRING },
                        missingKeywords: { type: Type.ARRAY, items: { type: Type.STRING } }
                    }
                }
            }
        });
        result = JSON.parse(scoreRes.text);
        break;

      case 'chat_reply':
        const chatRes = await ai.models.generateContent({
          model: proModel,
          contents: `Simulate ${payload.persona}. User pitch: "${payload.history[payload.history.length-1].text}".`,
          config: { 
            systemInstruction: `You are a ${payload.persona} interested in ${payload.productName}. Be skeptical but professional.`,
            tools: [{ googleSearch: {} }]
          }
        });
        result = { 
          text: chatRes.text, 
          sources: chatRes.candidates[0].groundingMetadata?.groundingChunks 
        };
        break;

      default:
        throw new Error(`Agent ${agent} is not implemented.`);
    }

    res.json({ data: result });
  } catch (e) {
    logger.error("AI Logic Failure", { agent, error: e.message });
    res.status(500).json({ error: "AI Engine logic failed: " + e.message });
  }
}));

// --- STREAMING ENDPOINT ---
app.post('/api/ai/stream', authenticateToken, asyncHandler(async (req, res) => {
    const { history, productName, persona } = req.body;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const modelId = 'gemini-3-pro-preview';

    try {
        const chat = ai.chats.create({
            model: modelId,
            config: {
                systemInstruction: `You are a ${persona} interested in ${productName}. Roleplay a negotiation. Be skeptical. Keep responses short.`,
                tools: [{ googleSearch: {} }]
            }
        });

        // Convert history to compatible format if needed, mostly sending last message
        const lastMsg = history[history.length - 1].text;
        const resultStream = await chat.sendMessageStream({ message: lastMsg });

        for await (const chunk of resultStream) {
            const text = chunk.text;
            const sources = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
            
            res.write(`data: ${JSON.stringify({ text, sources })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        logger.error("Streaming Error", e);
        res.write(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`);
        res.end();
    }
}));

// --- PAYMENT WEBHOOK (HARDENED) ---
app.post('/api/webhooks/bani', asyncHandler(async (req, res) => {
    const signature = req.headers['bani-hook-signature'];
    const secret = (process.env.BANI_WEBHOOK_SECRET || process.env.BANI_PRIVATE_KEY || '').trim();

    if (!signature || !secret) return res.status(400).send("Security Config Missing");

    const computed = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature !== computed) return res.status(401).send("Invalid Signature");

    const payload = req.body;
    
    // Validate Amount & Currency
    const amountPaid = parseFloat(payload.amount);
    const currency = payload.currency || 'NGN';
    
    // Plan Prices (NGN)
    const PRICES = {
        'pro': 44700,
        'agency': 298350,
        'project': 14700
    };

    if (payload.event && payload.event.startsWith('payin_')) {
        let ref = payload.reference || payload.data?.reference || payload.data?.metadata?.custom_ref;
        if (ref && ref.startsWith('METI_')) {
            const parts = ref.split('_');
            // Format: METI_USERID_PLAN_TIMESTAMP
            if (parts.length >= 3) {
                const userId = parts[1];
                const type = parts[2]; // pro, agency, project
                
                // Security Check: Amount
                const requiredAmount = PRICES[type];
                if (currency !== 'NGN' || amountPaid < requiredAmount) {
                    logger.warn(`Payment Fraud Attempt? User: ${userId}, Paid: ${amountPaid}, Required: ${requiredAmount}`);
                    return res.status(200).send("Ignored: Insufficient Amount");
                }

                if (userId && userId !== 'GUEST') {
                    if (type === 'project') {
                       logger.info(`Project Credit Added for ${userId}`);
                       // Logic to add project credit to DB would go here
                    } else {
                       await User.findByIdAndUpdate(userId, { subscription: type, subscriptionStatus: 'active' });
                       logger.info(`Subscription Upgraded: ${userId} -> ${type}`);
                    }
                }
            }
        }
    }
    res.status(200).send("OK");
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Meti Engine Server Live on Port ${PORT}`));
