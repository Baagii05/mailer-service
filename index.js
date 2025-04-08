const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const AWS = require('aws-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT_MAIL_SERVICE || 5002;

app.use(express.json());
app.use(cors());

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1', 
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY 
});

const s3 = new AWS.S3();

mongoose.connect(process.env.MONGO_URI, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

const EmailLog = mongoose.model('EmailLog', new mongoose.Schema({ 
  to: String, 
  subject: String, 
  body: String,
  htmlBody: String,
  embeddedImages: [{
    cid: String,
    filename: String,
    s3Key: String,
    contentType: String,
    size: Number
  }],
  attachments: [{ 
    filename: String,
    s3Key: String,
    contentType: String,
    size: Number
  }],
  timestamp: { type: Date, default: Date.now } 
}));

async function getFileFromS3(key) {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key
  };
  
  try {
    const data = await s3.getObject(params).promise();
    return {
      content: data.Body,
      contentType: data.ContentType
    };
  } catch (error) {
    console.error('Error fetching file from S3:', error);
    throw error;
  }
}

function generateHTMLEmail(subject, body, embeddedImageCids = []) {

  let imageHtml = '';
  embeddedImageCids.forEach(cid => {
    imageHtml += `<div class="image-container"><img src="cid:${cid}" alt="Embedded Image" style="max-width: 100%;"></div>`;
  });

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .header {
          border-bottom: 2px solid #f0f0f0;
          padding-bottom: 15px;
          margin-bottom: 20px;
        }
        h1 {
          color: #2c3e50;
          margin-top: 0;
        }
        .content {
          margin-bottom: 30px;
        }
        .image-container {
          margin: 20px 0;
        }
        .footer {
          border-top: 1px solid #f0f0f0;
          padding-top: 15px;
          font-size: 12px;
          color: #777;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>${subject}</h1>
      </div>
      <div class="content">
        ${body}
      </div>
      ${imageHtml}
      <div class="footer">
        <p>This email was sent automatically. Please do not reply directly to this message.</p>
      </div>
    </body>
    </html>
  `;
}

app.post('/send-email', async (req, res) => {
  const { to, subject, body, attachmentKeys, embeddedImageKeys, useHtmlTemplate = true } = req.body;
  
  if (!to || !subject || !body) {
    return res.status(400).json({ message: 'Missing required fields: to, subject, body' });
  }
  
  try {
    const attachmentLogs = [];
    const embeddedImageLogs = [];
    const embeddedImageCids = [];
    
    
    const msg = {
      to,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject,
      attachments: []
    };
    
    
    if (embeddedImageKeys && embeddedImageKeys.length > 0) {
      for (let i = 0; i < embeddedImageKeys.length; i++) {
        const key = embeddedImageKeys[i];
        const file = await getFileFromS3(key);
        const filename = key.split('/').pop();
        const cid = `image-${i+1}`;
        
        
        msg.attachments.push({
          content: file.content.toString('base64'),
          filename: filename,
          type: file.contentType,
          disposition: 'inline',
          content_id: cid
        });
        
        embeddedImageCids.push(cid);
        
        embeddedImageLogs.push({
          cid,
          filename,
          s3Key: key,
          contentType: file.contentType,
          size: file.content.length
        });
      }
    }
    
    
    let htmlContent;
    let plainTextContent = body;
    
    if (useHtmlTemplate) {
      
      htmlContent = generateHTMLEmail(subject, body, embeddedImageCids);
      msg.html = htmlContent;
      msg.text = plainTextContent;
    } else {
      
      msg.html = body;
      msg.text = body.replace(/<[^>]*>/g, '');
    }
    
    
    if (attachmentKeys && attachmentKeys.length > 0) {
      for (const key of attachmentKeys) {
        const file = await getFileFromS3(key);
        const filename = key.split('/').pop();
        
        msg.attachments.push({
          content: file.content.toString('base64'),
          filename: filename,
          type: file.contentType,
          disposition: 'attachment'
        });
        
        attachmentLogs.push({
          filename: filename,
          s3Key: key,
          contentType: file.contentType,
          size: file.content.length
        });
      }
    }

    await sgMail.send(msg);

    await EmailLog.create({ 
      to, 
      subject, 
      body: plainTextContent,
      htmlBody: msg.html,
      embeddedImages: embeddedImageLogs,
      attachments: attachmentLogs 
    });
    
    res.status(200).json({ 
      message: 'Email sent successfully',
      htmlGenerated: useHtmlTemplate
    });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ 
      message: 'Failed to send email', 
      error: error.response ? error.response.body : error.message 
    });
  }
});


app.post('/preview-email', (req, res) => {
  const { subject, body, embeddedImageCount } = req.body;
  
  if (!subject || !body) {
    return res.status(400).json({ message: 'Missing required fields: subject, body' });
  }
  
  
  const dummyCids = [];
  for (let i = 0; i < (embeddedImageCount || 0); i++) {
    dummyCids.push(`preview-image-${i+1}`);
  }
  
  const html = generateHTMLEmail(subject, body, dummyCids);
  res.json({ html });
});

app.get('/emails', async (req, res) => {
  try {
    const { search } = req.query;
    let query = {};
    
    if (search) {
      query = {
        $or: [
          { to: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
          { body: { $regex: search, $options: 'i' } }
        ]
      };
    }
    
    const emails = await EmailLog.find(query).sort({ timestamp: -1 });
    res.json(emails);
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ message: 'Failed to fetch emails', error: error.message });
  }
});

app.listen(PORT, () => console.log(`Mail Service running on port ${PORT}`));