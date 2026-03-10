// ============================================================
// seed-site-maps.js
// Fetches help documentation for common sites, sends to model API
// for synthesis, writes site maps to data/site-maps.json.
//
// Usage: GEMINI_API_KEY=... npm run seed
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'site-maps.json');

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-2.0-flash';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable.');
  process.exit(1);
}

// ── Site configs ──

const sites = [
  {
    hostname: "music.apple.com",
    helpUrls: [
      "https://support.apple.com/en-us/guide/music/",
      "https://en.wikipedia.org/wiki/Apple_Music"
    ]
  },
  {
    hostname: "amazon.com",
    helpUrls: [
      "https://en.wikipedia.org/wiki/Amazon_(company)",
      "https://en.wikipedia.org/wiki/Amazon_checkout"
    ]
  },
  {
    hostname: "mail.google.com",
    helpUrls: [
      "https://support.google.com/mail/answer/6594?hl=en",
      "https://support.google.com/mail/answer/22839?hl=en"
    ]
  },
  {
    hostname: "ticketmaster.com",
    helpUrls: [
      "https://help.ticketmaster.com/hc/en-us",
      "https://en.wikipedia.org/wiki/Ticketmaster"
    ]
  },
  {
    hostname: "stubhub.com",
    helpUrls: [
      "https://support.stubhub.com/",
      "https://en.wikipedia.org/wiki/StubHub"
    ]
  }
];

// ── Helpers ──

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return stripHtml(html);
  } catch (err) {
    console.error(`  [skip] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

async function synthesize(hostname, combinedText) {
  const prompt = `You are helping an AI browser agent learn how to navigate ${hostname}.

Here is the official help documentation for this site:

${combinedText}

Based on this documentation, write a concise site map (under 300 words) covering:
1. Key pages and how to navigate between them
2. Primary interactive elements (search bars, buttons, forms) and where they appear
3. Typical interaction sequences for common tasks (search, play, buy, send, etc.)
4. Any spatial relationships mentioned (e.g. "results appear below search bar", "play button appears on hover over a track")

Be specific. Prefer concrete descriptions over general ones.
This will be used to guide a browser agent operating on this site.`;

  const url = `${GEMINI_API_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.1
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini API error (${response.status})`);
  }
  return data.candidates[0].content.parts[0].text;
}

// ── Main ──

async function main() {
  const output = {};

  for (const site of sites) {
    console.log(`\n[${site.hostname}]`);

    const texts = [];
    for (const url of site.helpUrls) {
      console.log(`  Fetching: ${url}`);
      const text = await fetchPage(url);
      if (text) texts.push(text);
    }

    if (texts.length === 0) {
      console.log(`  No content fetched, skipping synthesis.`);
      continue;
    }

    const combinedText = texts.join('\n\n---\n\n');
    console.log(`  Synthesizing (${combinedText.length} chars)...`);

    try {
      const teachMap = await synthesize(site.hostname, combinedText);
      output[site.hostname] = {
        teachMap,
        generatedAt: new Date().toISOString(),
        source: 'help-docs'
      };
      console.log(`  Done.`);
    } catch (err) {
      console.error(`  Synthesis failed: ${err.message}`);
    }
  }

  // Ensure data directory exists
  const dataDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${Object.keys(output).length} site maps to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
