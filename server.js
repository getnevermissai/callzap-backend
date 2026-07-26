require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = twilio(
  process.env.AC0af640d30261e4a630a0b74ae79d5089,
  process.env.bba65265a5c5e87aa0aed5f819794a79,
);

app.get('/', (req, res) => {
  res.json({ status: 'CallZap Backend Running! ⚡' });
});

app.post('/missed-call', async (req, res) => {
  const callerNumber = req.body.From;
  
  console.log(`Missed call from ${callerNumber}`);
  
  try {
    await client.messages.create({
      body: `Hi! Sorry we missed your call. We will get back to you shortly. How can we help you today?`,
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
to: 'whatsapp:' + callerNumber
    });
    
    console.log(`Auto text sent to ${callerNumber}`);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CallZap backend running on port ${PORT}`);
});
