import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5001;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in server/.env');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  const db = cachedClient.db('medical_bot');
  return { db };
}

app.get('/api/health', async (req, res) => {
  try {
    const { db } = await getDb();
    await db.command({ ping: 1 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/transcripts', async (req, res) => {
  try {
    const { summary, patientInfo, transcript, callDuration } = req.body || {};

    if (!transcript) {
      return res.status(400).json({ success: false, error: 'transcript is required' });
    }
    console.log('Received /api/transcripts', {
      transcriptLength: typeof transcript === 'string' ? transcript.length : null,
      hasSummary: !!summary,
      hasPatientInfo: !!patientInfo,
      callDuration,
    });

    const { db } = await getDb();
    const collection = db.collection('transcripts');

    const doc = {
      summary: summary || '',
      patientInfo: patientInfo || {},
      transcript,
      callDuration: typeof callDuration === 'number' ? callDuration : null,
      createdAt: new Date(),
      timestamp: new Date().toISOString(),
    };

    const result = await collection.insertOne(doc);
    res.json({ success: true, id: result.insertedId });
  } catch (err) {
    console.error('Error saving transcript:', err);
    res.status(500).json({ success: false, error: err.message || 'Unknown error' });
  }
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
