import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { MongoClient } from "https://deno.land/x/mongo@v0.32.0/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { summary, patientInfo, transcript, callDuration } = await req.json();

    console.log('Received transcript data:', { summary, patientInfo, callDuration });

    const MONGODB_URI = Deno.env.get('MONGODB_URI');
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not configured');
    }

    // Connect to MongoDB
    const client = new MongoClient();
    await client.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = client.database('medical_bot');
    const collection = db.collection('transcripts');

    // Create document to insert
    const document = {
      summary,
      patientInfo,
      transcript,
      callDuration,
      createdAt: new Date(),
      timestamp: new Date().toISOString(),
    };

    // Insert the document
    const result = await collection.insertOne(document);
    console.log('Inserted document with ID:', result);

    client.close();

    return new Response(
      JSON.stringify({ 
        success: true, 
        id: result,
        message: 'Transcript saved successfully'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error) {
    console.error('Error saving transcript:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        success: false
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});