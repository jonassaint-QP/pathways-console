import { Handler } from '@netlify/functions';

interface BufferPost {
  text: string;
  media?: {
    link?: string;
    description?: string;
  }[];
  profiles?: string[];
  scheduleTime?: number;
}

interface PublishRequest {
  text: string;
  mediaUrls?: string[];
  profiles?: string[]; // Buffer profile IDs
  scheduleTime?: number;
}

const handler: Handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { text, mediaUrls, profiles, scheduleTime }: PublishRequest = JSON.parse(
      event.body || '{}'
    );

    // Validate required fields
    if (!text || !profiles || profiles.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields: text and profiles (array)',
        }),
      };
    }

    const bufferApiKey = process.env.BUFFER_API_KEY;
    if (!bufferApiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Buffer API key not configured' }),
      };
    }

    // Build the Buffer post payload
    const bufferPost: BufferPost = {
      text,
      profiles,
    };

    // Add media if provided
    if (mediaUrls && mediaUrls.length > 0) {
      bufferPost.media = mediaUrls.map((url) => ({
        link: url,
      }));
    }

    // Add schedule time if provided
    if (scheduleTime) {
      bufferPost.scheduleTime = scheduleTime;
    }

    // Publish to Buffer API
    const bufferResponse = await fetch('https://api.bufferapp.com/1/updates/create.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...bufferPost,
        access_token: bufferApiKey,
      }),
    });

    if (!bufferResponse.ok) {
      const errorData = await bufferResponse.json();
      return {
        statusCode: bufferResponse.status,
        body: JSON.stringify({
          error: 'Buffer API error',
          details: errorData,
        }),
      };
    }

    const result = await bufferResponse.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        bufferId: result.id,
        message: 'Post published to Buffer successfully',
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to publish to Buffer',
        details: errorMessage,
      }),
    };
  }
};

export { handler };
