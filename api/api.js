// api.js - Serverless API for Vercel
// Handles POST requests with text corrections via OpenRouter AI and TTS conversion

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Main serverless function handler
 */
export default async function handler(req, res) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed. Use POST.' 
    });
  }

  try {
    // Parse request body
    const { text, voice = 'smooth_female' } = req.body;

    // Validate input
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Invalid input: "text" field is required and must be a non-empty string.' 
      });
    }

    if (text.trim().length > 5000) {
      return res.status(400).json({ 
        error: 'Text too long. Maximum 5000 characters allowed.' 
      });
    }

    // Step 1: Get English corrections from OpenRouter AI
    const correctedText = await getCorrectionsFromAI(text.trim());

    // Step 2: Convert corrected text to speech with selected voice
    const audioUrl = await textToSpeech(correctedText, voice);

    // Return successful response
    return res.status(200).json({
      corrected_text: correctedText,
      audio_url: audioUrl
    });

  } catch (error) {
    console.error('API Error:', error);
    
    // Provide detailed error response
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      corrected_text: null,
      audio_url: null
    });
  }
}

/**
 * Get English corrections and feedback from OpenRouter AI
 * Uses Qwen model for high-quality grammar and fluency corrections
 */
async function getCorrectionsFromAI(userText) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  const prompt = `You are an expert English communication coach. Your task is to correct and improve the following text for grammar, fluency, and professionalism. 

Rules:
1. Fix any grammar mistakes, awkward phrasing, or unnatural expressions
2. Improve vocabulary where appropriate while keeping the original meaning
3. Maintain the user's original intent and tone
4. Return ONLY the corrected text, no explanations, no quotes, no additional text
5. If the text is already perfect, return it unchanged

Original text: "${userText}"

Corrected version:`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://echolearn.vercel.app',
        'X-Title': 'EchoLearn AI Coach'
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-72b-instruct',
        messages: [
          {
            role: 'system',
            content: 'You are a professional English language coach. Provide only the corrected text without any additional commentary.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        top_p: 0.95
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorData}`);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    let corrected = data.choices[0].message.content.trim();
    
    // Remove any quotes if present
    corrected = corrected.replace(/^["']|["']$/g, '');
    
    // If correction is empty or just whitespace, return original
    if (!corrected || corrected.length === 0) {
      return userText;
    }
    
    return corrected;

  } catch (error) {
    console.error('AI Correction Error:', error);
    // Fallback to basic correction if AI fails
    return basicFallbackCorrection(userText);
  }
}

/**
 * Text-to-Speech conversion using free TTS engines
 * Supports 4 voice types with different characteristics
 */
async function textToSpeech(text, voiceOption) {
  // Map voice options to Google TTS voice parameters
  const voiceMapping = {
    deep_male: {
      languageCode: 'en-US',
      name: 'en-US-Neural2-D',
      ssmlGender: 'MALE'
    },
    smooth_male: {
      languageCode: 'en-US',
      name: 'en-US-Neural2-J',
      ssmlGender: 'MALE'
    },
    smooth_female: {
      languageCode: 'en-US',
      name: 'en-US-Neural2-F',
      ssmlGender: 'FEMALE'
    },
    deep_female: {
      languageCode: 'en-US',
      name: 'en-US-Neural2-C',
      ssmlGender: 'FEMALE'
    }
  };

  const voice = voiceMapping[voiceOption] || voiceMapping.smooth_female;
  
  // Try Google Cloud TTS first (requires API key)
  const googleApiKey = process.env.GOOGLE_TTS_API_KEY;
  
  if (googleApiKey) {
    try {
      const audioBase64 = await googleTTS(text, voice, googleApiKey);
      if (audioBase64) {
        return `data:audio/mp3;base64,${audioBase64}`;
      }
    } catch (error) {
      console.error('Google TTS failed, falling back to browser TTS:', error);
    }
  }
  
  // Fallback: Use ElevenLabs if available
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  if (elevenLabsKey) {
    try {
      const audioUrl = await elevenLabsTTS(text, voiceOption, elevenLabsKey);
      if (audioUrl) {
        return audioUrl;
      }
    } catch (error) {
      console.error('ElevenLabs TTS failed:', error);
    }
  }
  
  // Final fallback: Return null (frontend will use browser TTS)
  return null;
}

/**
 * Google Cloud Text-to-Speech API integration
 * Free tier: 1 million characters per month
 */
async function googleTTS(text, voiceConfig, apiKey) {
  const url = `https://texttospeech.googleapis.com/v1/text:synthesis?key=${apiKey}`;
  
  const requestBody = {
    input: {
      text: text
    },
    voice: {
      languageCode: voiceConfig.languageCode,
      name: voiceConfig.name,
      ssmlGender: voiceConfig.ssmlGender
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0,
      volumeGainDb: 0
    }
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google TTS error: ${error}`);
  }
  
  const data = await response.json();
  return data.audioContent; // Base64 encoded audio
}

/**
 * ElevenLabs TTS API integration
 * Free tier: 10,000 characters per month
 */
async function elevenLabsTTS(text, voiceOption, apiKey) {
  // Map EchoLearn voices to ElevenLabs voice IDs
  const voiceIdMapping = {
    deep_male: '21m00Tcm4TlvDq8ikWAM',  // Adam - deep male
    smooth_male: 'AZnzlk1XvdvUeBnXmlld',  // Josh - smooth male
    smooth_female: 'EXAVITQu4L4GjE1L4p7Y', // Sarah - smooth female
    deep_female: 'GBv7mTt0atIp3Br8iCZE'   // Emily - deep female
  };
  
  const voiceId = voiceIdMapping[voiceOption] || voiceIdMapping.smooth_female;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs error: ${error}`);
  }
  
  const audioBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(audioBuffer).toString('base64');
  return `data:audio/mpeg;base64,${base64}`;
}

/**
 * Basic fallback correction when AI is unavailable
 * Performs simple grammar fixes
 */
function basicFallbackCorrection(text) {
  let corrected = text;
  
  // Fix common grammar issues
  const corrections = [
    { pattern: /\b(i)\s+([a-z])/gi, replacement: 'I $2' },
    { pattern: /\b(\d+)\s+year\b/gi, replacement: '$1 years' },
    { pattern: /\b(\d+)\s+month\b/gi, replacement: '$1 months' },
    { pattern: /\b(\d+)\s+day\b/gi, replacement: '$1 days' },
    { pattern: /\bam\s+go\b/gi, replacement: 'am going' },
    { pattern: /\bis\s+go\b/gi, replacement: 'is going' },
    { pattern: /\bare\s+go\b/gi, replacement: 'are going' },
    { pattern: /\b(he|she|it)\s+go\b/gi, replacement: '$1 goes' }
  ];
  
  corrections.forEach(({ pattern, replacement }) => {
    corrected = corrected.replace(pattern, replacement);
  });
  
  // Capitalize first letter of sentences
  corrected = corrected.replace(/(^\s*|[.!?]\s+)([a-z])/g, (match, separator, letter) => {
    return separator + letter.toUpperCase();
  });
  
  return corrected;
}

// Export for Vercel serverless function
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};
