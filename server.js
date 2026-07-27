require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Store conversations and leads
const conversations = {};


app.get('/', (req, res) => {
  res.json({ status: 'CallZap AI Backend Running! ⚡' });
});

// Get all leads
app.get('/leads/:businessId', async (req, res) => {
  try {
    const businessId = req.params.businessId;
    const snapshot = await db.collection('leads')
      .doc(businessId)
      .collection('customers')
      .orderBy('timestamp', 'desc')
      .get();
    
    const leads = [];
    snapshot.forEach(doc => {
      leads.push({ id: doc.id, ...doc.data() });
    });
    
    res.json(leads);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// Missed call webhook
app.post('/missed-call', async (req, res) => {
  const callerNumber = req.body.From;
  const businessNumber = req.body.To;
  const businessName = req.body.businessName || 'our business';
const businessServices = req.body.services || 'our services';
const businessHours = req.body.hours || '9 AM - 6 PM';

  console.log(`Missed call from ${callerNumber}`);

  // Get client Twilio credentials
  const accountSid = req.body.AccountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioClient = twilio(accountSid, authToken);

  try {
    await twilioClient.messages.create({
      body: `Hi! 👋 Sorry we missed your call! I'm the AI assistant for ${businessName}. Can I help you today?`,
      from: businessNumber,
      to: callerNumber
    });

    // Initialize conversation with lead qualification prompt
    conversations[callerNumber] = {
      messages: [
        {
          role: 'system',
          content: `You are CallZap AI assistant for ${businessName}.
          Business services: ${businessServices}
Working hours: ${businessHours}

Your goal is to qualify leads and collect:
1. Customer name
2. Service they need
3. Urgency (low/medium/high)
4. Preferred appointment date and time

Rules:
- Never ask more than ONE question at a time
- Keep messages SHORT (under 100 words)
- Be friendly and professional
- After collecting all info, confirm the booking
- End with: "BOOKING_COMPLETE" when appointment is confirmed`
        }
      ],
      leadData: {
        phone: callerNumber,
        business: businessNumber,
        name: null,
        service: null,
        urgency: null,
        appointment: null,
        score: null,
        status: 'NEW'
      }
    };

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

// Handle incoming SMS replies
app.post('/incoming-sms', async (req, res) => {
  const customerNumber = req.body.From;
  const customerMessage = req.body.Body;
  const businessNumber = req.body.To;

  console.log(`Message from ${customerNumber}: ${customerMessage}`);

  try {
    if (!conversations[customerNumber]) {
      conversations[customerNumber] = {
        messages: [
          {
            role: 'system',
            content: `You are CallZap AI assistant. 
Qualify leads by collecting: name, service needed, urgency, appointment date/time.
Ask ONE question at a time. Keep messages short and friendly.
End with "BOOKING_COMPLETE" when appointment is confirmed.`
          }
        ],
        leadData: {
          phone: customerNumber,
          business: businessNumber,
          name: null,
          service: null,
          urgency: null,
          appointment: null,
          score: null,
          status: 'NEW'
        }
      };
    }

    const conv = conversations[customerNumber];

    conv.messages.push({
      role: 'user',
      content: customerMessage
    });

    // Get AI reply
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: conv.messages,
      max_tokens: 150
    });

    const aiReply = completion.choices[0].message.content;

    conv.messages.push({
      role: 'assistant',
      content: aiReply
    });

    // Extract lead data using AI
    const extractCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Extract lead information from conversation. Return ONLY valid JSON with fields: name, service, urgency, appointment. Use null for missing fields.'
        },
        {
          role: 'user',
          content: `Conversation: ${JSON.stringify(conv.messages.slice(1))}`
        }
      ],
      max_tokens: 200
    });

    try {
      const extracted = JSON.parse(extractCompletion.choices[0].message.content);
      conv.leadData = { ...conv.leadData, ...extracted };
    } catch (e) {
      console.log('Could not extract lead data yet');
    }

    // Check if booking is complete
    if (aiReply.includes('BOOKING_COMPLETE')) {
      // Get lead score
      const scoreCompletion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'Rate this lead from 1-100. Return ONLY JSON: {"score": number, "status": "HOT/WARM/COLD", "summary": "one line summary"}'
          },
          {
            role: 'user',
            content: `Lead data: ${JSON.stringify(conv.leadData)}`
          }
        ],
        max_tokens: 100
      });

      try {
        const scoreData = JSON.parse(scoreCompletion.choices[0].message.content);
        conv.leadData.score = scoreData.score;
        conv.leadData.status = scoreData.status;
        conv.leadData.summary = scoreData.summary;
      } catch (e) {
        conv.leadData.score = 75;
        conv.leadData.status = 'WARM';
      }
// Generate conversation summary
const summaryCompletion = await openai.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [
    {
      role: 'system',
      content: 'Generate a short conversation summary. Return ONLY JSON: {"summary": "2-3 line summary", "nextAction": "what business should do next"}'
    },
    {
      role: 'user',
      content: `Conversation: ${JSON.stringify(conv.messages.slice(1))}, Lead data: ${JSON.stringify(conv.leadData)}`
    }
  ],
  max_tokens: 150
});

try {
  const summaryData = JSON.parse(summaryCompletion.choices[0].message.content);
  conv.leadData.conversationSummary = summaryData.summary;
  conv.leadData.nextAction = summaryData.nextAction;
} catch(e) {
  conv.leadData.conversationSummary = 'Customer contacted about service';
}

// Save to Firebase
await db.collection('leads')
  .doc(conv.leadData.business || 'default')
  .collection('customers')
  .add({
    ...conv.leadData,
    timestamp: new Date().toISOString()
  });

console.log('Lead saved to Firebase!');
    }

    // Send reply via Twilio
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioClient = twilio(accountSid, authToken);

    await twilioClient.messages.create({
      body: aiReply.replace('BOOKING_COMPLETE', '').trim(),
      from: businessNumber,
      to: customerNumber
    });

    res.status(200).send('OK');

  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});
// Add Firebase service account to environment
app.get('/health', (req, res) => {
  res.json({ 
    status: 'CallZap AI Running! ⚡',
    firebase: 'connected',
    timestamp: new Date().toISOString()
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CallZap AI backend running on port ${PORT}`);
});
