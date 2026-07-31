require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});
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
    
    // Basic auth check
    const authToken = req.headers['x-business-token'];
    if (!authToken || authToken !== businessId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const snapshot = await db.collection('leads')
      .doc(businessId)
      .collection('customers')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const leads = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
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
    const existingCustomer = await db.collection('leads')
  .doc(businessNumber)
  .collection('customers')
  .where('phone', '==', callerNumber)
  .limit(1)
  .get();

let customerName = null;
let isReturning = false;

if (!existingCustomer.empty) {
  const customerData = existingCustomer.docs[0].data();
  customerName = customerData.name;
  isReturning = true;
}

const greeting = isReturning && customerName
  ? `Hi ${customerName}! Welcome back to ${businessName}! 😊 What service do you need today?`
  : `Hi! 👋 Sorry we missed your call at ${businessName}! How can we help you today?`;

await twilioClient.messages.create({
  body: greeting,
  from: businessNumber,
  to: callerNumber
});

conversations[callerNumber] = {
  messages: [
    {
      role: 'system',
      content: `You are CallZap AI assistant for ${businessName}.
${isReturning && customerName ? `Customer name is already known: ${customerName}. Skip asking their name and go directly to what service they need.` : ''}

Your goal is to qualify leads and collect:
${isReturning ? '1. Service they need\n2. Urgency\n3. Preferred appointment date and time' : '1. Customer name\n2. Service they need\n3. Urgency\n4. Preferred appointment date and time'}

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
    name: customerName,
    service: null,
    urgency: null,
    appointment: null,
    score: null,
    status: 'NEW',
    isReturning: isReturning
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
// Send HOT lead email notification
if (conv.leadData.status === 'HOT') {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER,
    subject: `🔥 HOT LEAD — ${conv.leadData.name} wants ${conv.leadData.service}!`,
    html: `
      <h2>🔥 New HOT Lead!</h2>
      <p><b>Customer:</b> ${conv.leadData.name}</p>
      <p><b>Service:</b> ${conv.leadData.service}</p>
      <p><b>Appointment:</b> ${conv.leadData.appointment}</p>
      <p><b>Score:</b> ${conv.leadData.score}/100</p>
      <p><b>Summary:</b> ${conv.leadData.conversationSummary}</p>
      <p><b>Action:</b> ${conv.leadData.nextAction}</p>
      <br>
      <a href="https://www.callzap.co/dashboard.html">View Dashboard →</a>
    `
  });
  console.log('HOT lead email sent!');
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
app.post('/buy-number', async (req, res) => {
  const { areaCode, country, businessName, userId } = req.body;

  try {
    let formattedAreaCode = areaCode;
    if ((country === 'GB' || country === 'AU') && formattedAreaCode.startsWith('0')) {
      formattedAreaCode = formattedAreaCode.substring(1);
    }

    const availableNumbers = await twilioClient
      .availablePhoneNumbers(country)
      .local
      .list({ areaCode: formattedAreaCode, limit: 1 });

    if (availableNumbers.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No numbers found in this area code. Try another!' 
      });
    }

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: availableNumbers[0].phoneNumber,
      friendlyName: `${businessName} - CallZap`,
      smsUrl: 'https://callzap-backend.onrender.com/incoming-sms',
      voiceUrl: 'https://callzap-backend.onrender.com/missed-call'
    });

    await db.collection('businesses').doc(userId).update({
      twilioPhone: purchasedNumber.phoneNumber,
      country: country
    });

    res.json({ 
      success: true, 
      phoneNumber: purchasedNumber.phoneNumber 
    });

  } catch (error) {
    console.error('Twilio Buy Error:', error);
    res.status(500).json({ success: false, error: error.message });
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
app.post('/api/business/config', async (req, res) => {
  try {
    const config = req.body;
    const businessId = config.twilioPhone || 'default';
    
    await db.collection('businesses')
      .doc(businessId)
      .set(config, { merge: true });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CallZap AI backend running on port ${PORT}`);
});
