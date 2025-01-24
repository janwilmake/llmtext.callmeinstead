/// <reference types="@cloudflare/workers-types" />
import twilio from "twilio";

export interface Env {
  DEEPGRAM_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TARGET_PHONE_NUMBER: string;
  WORKER_HOST: string;
  INSTRUCTIONS_URL: string;
  TEST_SECRET: string;
}

export const createStreamPhonecall = async (context: {
  /** Your Twilio Account SID */
  twilioAccountSid: string;
  /** Your Twilio Auth Token */
  twilioAuthToken: string;
  /** Phone number to call in E.164 format (+1234567890) */
  phoneNumber: string;
  /** WebSocket URL for audio streaming */
  streamUrl: string;
  /** Caller ID (Twilio number in E.164 format) */
  fromNumber: string;
}) => {
  const {
    twilioAccountSid,
    twilioAuthToken,
    phoneNumber,
    streamUrl,
    fromNumber,
  } = context;

  try {
    // Validate phone number format
    if (phoneNumber.startsWith("+")) {
      return {
        isSuccessful: false,
        message: "Phone number must be without + (1234567890)",
      };
    }

    // Basic region check
    const isEea = phoneNumber.startsWith("3") || phoneNumber.startsWith("4");
    const isUs = phoneNumber.startsWith("1");
    if (!isEea && !isUs) {
      return {
        isSuccessful: false,
        message: "Only EU and US numbers supported",
      };
    }

    const client = twilio(twilioAccountSid, twilioAuthToken);
    const twiml = new twilio.twiml.VoiceResponse();

    twiml.connect().stream({
      url: streamUrl,
      name: "LiveAudioStream123",
    });

    const call = await client.calls.create({
      twiml: twiml.toString(),
      to: phoneNumber,
      from: fromNumber,
      record: false,
      machineDetection: "Enable",
    });

    return {
      isSuccessful: true,
      message: "Call initiated with audio stream",
      callSid: call.sid,
    };
  } catch (error: any) {
    console.error("Twilio Error:", error);
    return {
      isSuccessful: false,
      message: error.message || "Failed to initiate call",
    };
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === "/test" &&
      env.TEST_SECRET === url.searchParams.get("secret")
    ) {
      console.log({ instructionsUrl: env.INSTRUCTIONS_URL });
      const streamUrl = `wss://${env.WORKER_HOST}/media-stream`;
      const result = await createStreamPhonecall({
        twilioAccountSid: env.TWILIO_ACCOUNT_SID,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        phoneNumber: env.TARGET_PHONE_NUMBER,
        streamUrl,
        fromNumber: env.TWILIO_FROM_NUMBER,
      });
      return new Response(JSON.stringify(result, undefined, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    // Handle WebSocket upgrade for media stream
    if (url.pathname === "/media-stream") {
      console.log("RECEIVED /media-stream");
      const instructionsUrl = env.INSTRUCTIONS_URL;
      if (!instructionsUrl) {
        return new Response("No instructions given", { status: 400 });
      }

      const instructionsResult = await fetch(instructionsUrl).then(
        async (res) => {
          return { status: res.status, text: await res.text() };
        },
      );
      console.log("result", instructionsResult);
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      server.accept();
      handleServerWebSocket(server, env, instructionsResult);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function handleServerWebSocket(
  twilioWebsocket: WebSocket,
  env: Env,
  instructionsResult: { status: number; text: string },
) {
  twilioWebsocket.accept();
  console.log("ENTERED THE WEBSOCKET");

  const agentWsUrl = "wss://sts.sandbox.deepgram.com/agent";
  const deepgramToken = env.DEEPGRAM_API_KEY;

  const audioQueue: any[] = [];
  let streamSid: undefined | string = undefined;

  let stsWs: WebSocket | null = null;

  const configMessage = {
    type: "SettingsConfiguration",
    audio: {
      input: {
        encoding: "mulaw",
        sample_rate: 8000,
      },
      output: {
        encoding: "mulaw",
        sample_rate: 8000,
        container: "none",
        buffer_size: 250,
      },
    },
    agent: {
      listen: {
        model: "nova-2",
      },
      think: {
        provider: "open_ai",
        model: "gpt-4o",
        instructions:
          instructionsResult.status === 200
            ? instructionsResult.text
            : "The instructions couldn't be found. Please let the user know that this is the case, and end your conversation afterwards",
        functions: [],
      },
      speak: {
        model: "aura-asteria-en",
      },
    },
  };

  function connectToSts() {
    return new WebSocket(agentWsUrl, ["token", deepgramToken]);
  }

  function handleStsWebSocket() {
    stsWs = connectToSts();
    stsWs.addEventListener("open", () => {
      stsWs?.send(JSON.stringify(configMessage));
    });

    stsWs.addEventListener("message", async (event) => {
      const message = event.data;

      if (typeof message === "string") {
        // this logs what is happening
        console.log(message);
        return;
      }

      const rawMulaw = message;
      const mulawString = String.fromCharCode(...new Uint8Array(rawMulaw));
      const mediaMessage = {
        event: "media",
        streamSid,
        media: { payload: btoa(mulawString) },
      };

      twilioWebsocket.send(JSON.stringify(mediaMessage));
    });
  }

  function handleTwilioWebSocket() {
    const BUFFER_SIZE = 20 * 160;
    let inbuffer: Uint8Array = new Uint8Array(0);

    twilioWebsocket.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data as string);
      if (data.event === "start") {
        const start = data.start;
        console.log("got our streamsid", streamSid);
        streamSid = start.streamSid;
      }
      if (data.event === "connected") {
        return;
      }
      if (data.event === "media") {
        const media = data.media;
        const chunk = new Uint8Array(
          atob(media.payload)
            .split("")
            .map((char) => char.charCodeAt(0)),
        );
        if (media.track === "inbound") {
          const newBuffer = new Uint8Array(inbuffer.length + chunk.length);
          newBuffer.set(inbuffer);
          newBuffer.set(chunk, inbuffer.length);
          inbuffer = newBuffer;
        }
      }
      if (data.event === "stop") {
        return;
      }

      while (inbuffer.length >= BUFFER_SIZE) {
        const chunk = inbuffer.slice(0, BUFFER_SIZE);
        audioQueue.push(chunk);
        inbuffer = inbuffer.slice(BUFFER_SIZE);

        if (stsWs && stsWs.readyState === WebSocket.OPEN) {
          stsWs.send(chunk.buffer);
        } else {
          console.warn("STS WebSocket not open, cannot send chunk");
        }
      }
    });
  }

  handleStsWebSocket();
  handleTwilioWebSocket();
}
