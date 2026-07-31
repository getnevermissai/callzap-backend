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
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const conversations = {};

app.get('/', (req, res) => {
  res.json({ status: 'CallZap AI Backend Running! ⚡' });
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
      return res.status(404).json({ success: false, error: 'No numbers found in this area code.' });
    }

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: availableNumbers[0].phoneNumber,
      friendlyName: `${businessName} - CallZap`,
      smsUrl: 'https://callzap-backend.onrender.com/incoming-sms',
      voiceUrl: 'https://callzap-backend.onrender.com/missed-call'
    });

    await db.collection('businesses').doc(userId || 'default').set({
      twilioPhone: purchasedNumber.phoneNumber,
      country: country,
      businessName: businessName
    }, { merge: true });

    res.json({ success: true, phoneNumber: purchasedNumber.phoneNumber });
  } catch (error) {
    console.error('Twilio Buy Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/business/config', async (req, res) => {
  try {
    const config = req.body;
    const businessId = config.twilioPhone || 'default';
    await db.collection('businesses').doc(businessId).set(config, { merge: true });
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'CallZap AI Running! ⚡',
    firebase: 'connected',
    timestamp: new Date().toISOString()
  });
});

app.get('/leads/:businessId', async (req, res) => {
  try {
    const businessId = req.params.businessId;
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

app.post('/missed-call', async (req, res) => {
  const callerNumber = req.body.From;
  const businessNumber = req.body.To;
  const businessName = req.body.CalledCity || 'our business';

  console.log(`Missed call from ${callerNumber}`);

  try {
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
      from: 'whatsapp:' + businessNumber,
      to: 'whatsapp:' + callerNumber
    });

    conversations[callerNumber] = {
      messages: [
        {
          role: 'system',
          content: `You are CallZap AI assistant for ${businessName}.
${isReturning && customerName ? `Customer name is already known: ${customerName}. Skip asking their name.` : ''}
Your goal is to qualify leads and collect:
${isReturning ? '1. Service they need\n2. Urgency\n3. Preferred date and time' : '1. Customer name\n2. Service they need\n3. Urgency\n4. Preferred date and time'}
Rules:
- Never ask more than ONE question at a time
- Keep messages SHORT
- Be friendly and professional
- After collecting all info, confirm booking
- End with: "BOOKING_COMPLETE" when confirmed`
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

app.post('/incoming-sms', async (req, res) => {
  const customerNumber = req.body.From.replace('whatsapp:', '');
  const customerMessage = req.body.Body;
  const businessNumber = req.body.To.replace('whatsapp:', '');

  console.log(`Message from ${customerNumber}: ${customerMessage}`);

  try {
    if (!conversations[customerNumber]) {
      conversations[customerNumber] = {
        messages: [
          {
            role: 'system',
            content: `You are CallZap AI assistant. Qualify leads by collecting: name, service needed, urgency, appointment date/time. Ask ONE question at a time. End with "BOOKING_COMPLETE" when confirmed.`
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
          status: 'NEW',
          isReturning: false
        }
      };
    }

    const conv = conversations[customerNumber];
    conv.messages.push({ role: 'user', content: customerMessage });

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: conv.messages,
      max_tokens: 150
    });

    const aiReply = completion.choices[0].message.content;
    conv.messages.push({ role: 'assistant', content: aiReply });

    const extractCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Extract lead info. Return ONLY JSON: {"name": "", "service": "", "urgency": "", "appointment": ""}'
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
    } catch(e) {}

    if (aiReply.includes('BOOKING_COMPLETE')) {
      const scoreCompletion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'Rate lead 1-100. Return ONLY JSON: {"score": number, "status": "HOT/WARM/COLD", "summary": "one line", "nextAction": "what to do"}'
          },
          {
            role: 'user',
            content: `Lead: ${JSON.stringify(conv.leadData)}`
          }
        ],
        max_tokens: 150
      });

      try {
        const scoreData = JSON.parse(scoreCompletion.choices[0].message.content);
        conv.leadData.score = scoreData.score;
        conv.leadData.status = scoreData.status;
        conv.leadData.conversationSummary = scoreData.summary;
        conv.leadData.nextAction = scoreData.nextAction;
      } catch(e) {
        conv.leadData.score = 75;
        conv.leadData.status = 'WARM';
      }

      await db.collection('leads')
        .doc(conv.leadData.business || 'default')
        .collection('customers')
        .add({
          ...conv.leadData,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: new Date().toISOString()
        });

      console.log('Lead saved to Firebase!');

      if (conv.leadData.status === 'HOT') {
        try {
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
              <a href="https://www.callzap.co/dashboard.html">View Dashboard →</a>
            `
          });
        } catch(e) {
          console.error('Email error:', e);
        }
      }
    }

    await twilioClient.messages.create({
      body: aiReply.replace('BOOKING_COMPLETE', '').trim(),
      from: 'whatsapp:' + businessNumber,
      to: 'whatsapp:' + customerNumber
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

app.post('/request-review', async (req, res) => {
  const { customerNumber, businessName } = req.body;
  try {
    await twilioClient.messages.create({
      body: `Hi! Thank you for visiting ${businessName}! 😊 How was your experience? Rate us 1-5 ⭐`,
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
      to: 'whatsapp:' + customerNumber
    });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CallZap AI backend running on port ${PORT}`);
});
