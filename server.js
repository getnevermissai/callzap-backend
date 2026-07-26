require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const cors = require('cors');

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

const conversations = {};

app.get('/', (req, res) => {
  res.json({ status: 'CallZap AI Backend Running! ⚡' });
});

// Missed call webhook
app.post('/missed-call', async (req, res) => {
  const callerNumber = req.body.From;
  
  console.log(`Missed call from ${callerNumber}`);
  
  try {
    await twilioClient.messages.create({
      body: `Hi! Sorry we missed your call! 😊 We are here to help. How can we assist you today? You can also book an appointment directly here!`,
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
      to: 'whatsapp:' + callerNumber
    });
    
    conversations[callerNumber] = [
      {
        role: 'system',
        content: `You are a friendly AI assistant for a local business using CallZap. 
        Your job is to:
        1. Help customers with their questions
        2. Book appointments when requested
        3. Collect reviews after appointments
        4. Be helpful and professional
        Keep responses short and friendly for WhatsApp messages.
        If customer wants to book appointment, ask for their preferred date and time.
        After booking, confirm the appointment details.`
      }
    ];
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

// Handle incoming WhatsApp replies
app.post('/incoming-sms', async (req, res) => {
  const customerNumber = req.body.From.replace('whatsapp:', '');
  const customerMessage = req.body.Body;
  
  console.log(`Message from ${customerNumber}: ${customerMessage}`);
  
  try {
    if (!conversations[customerNumber]) {
      conversations[customerNumber] = [
        {
          role: 'system',
          content: `You are a friendly AI assistant for a local business using CallZap.
          Help customers, answer questions, book appointments and collect reviews.
          Keep responses short and friendly for WhatsApp.
          After completing a booking, ask for a review.`
        }
      ];
    }
    
    conversations[customerNumber].push({
      role: 'user',
      content: customerMessage
    });
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: conversations[customerNumber],
      max_tokens: 150
    });
    
    const aiReply = completion.choices[0].message.content;
    
    conversations[customerNumber].push({
      role: 'assistant',
      content: aiReply
    });
    
    await twilioClient.messages.create({
      body: aiReply,
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
      to: 'whatsapp:' + customerNumber
    });
    
    console.log(`AI replied: ${aiReply}`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

// Request review after appointment
app.post('/request-review', async (req, res) => {
  const customerNumber = req.body.customerNumber;
  const businessName = req.body.businessName;
  
  try {
    await twilioClient.messages.create({
      body: `Hi! Thank you for visiting ${businessName}! 😊 How was your experience? Please rate us 1-5 ⭐`,
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
