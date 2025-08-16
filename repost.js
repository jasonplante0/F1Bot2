const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { BskyAgent, RichText } = require('@atproto/api');
const { JSDOM } = require('jsdom');

const {
  MASTODON_ACCESS_TOKEN,
  MASTODON_API_URL,
  MASTODON_ACCOUNT_ID,
  BLUESKY_HANDLE,
  BLUESKY_PASSWORD,
} = process.env;

if (!MASTODON_ACCESS_TOKEN || !MASTODON_API_URL || !MASTODON_ACCOUNT_ID || !BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const POSTED_IDS_FILE = 'posted_ids.json';
const BLUESKY_IMAGE_MAX_SIZE = 1024 * 1024; // 1MB
const BLUESKY_VIDEO_MAX_SIZE = 100 * 1024 * 1024; // 100MB
const BLUESKY_MAX_CHARS = 300;

let postedIds = [];
if (fs.existsSync(POSTED_IDS_FILE)) {
  try {
    postedIds = JSON.parse(fs.readFileSync(POSTED_IDS_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading posted_ids.json:', e);
    postedIds = [];
  }
}

function savePostedIds() {
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify(postedIds, null, 2));
}

async function downloadMediaBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media: ${url}`);
  return await res.buffer();
}

async function processImageBuffer(buffer) {
  let processedBuffer = buffer;
  let metadata = await sharp(buffer).metadata();

  // Convert to JPEG if not JPEG/PNG
  let format = metadata.format;
  if (format !== 'jpeg' && format !== 'png') {
    processedBuffer = await sharp(buffer).jpeg().toBuffer();
    format = 'jpeg';
  }

  // Compress/resize if over 1MB
  let size = processedBuffer.length;
  if (size > BLUESKY_IMAGE_MAX_SIZE) {
    let quality = 90;
    while (size > BLUESKY_IMAGE_MAX_SIZE && quality > 10) {
      processedBuffer = await sharp(processedBuffer)
        .jpeg({ quality })
        .toBuffer();
      size = processedBuffer.length;
      quality -= 10;
    }
  }

  // Final check
  if (processedBuffer.length > BLUESKY_IMAGE_MAX_SIZE) {
    console.warn(`Image buffer could not be compressed under 1MB, skipping.`);
    return null;
  }
  return processedBuffer;
}

async function fetchMastodonPosts() {
  const url = `${MASTODON_API_URL}/api/v1/accounts/${MASTODON_ACCOUNT_ID}/statuses?limit=5&exclude_replies=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Mastodon posts: ${res.statusText}`);
  return res.json();
}

// Convert Mastodon HTML content to plain text, preserving links/mentions using RichText
async function mastodonToRichText(agent, html) {
  if (!html) return null;
  // Remove twitter.com and x.com URLs
  html = html.replace(/https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^\s<]+/gi, '');
  // Parse HTML to text, preserving links/mentions
  const dom = new JSDOM(html);
  const text = dom.window.document.body.textContent || '';
  const rt = new RichText({ text: text.trim() });
  await rt.detectFacets(agent);
  return rt;
}

// BlueSky media embed (images or one video per post)
async function postToBlueSky(agent, richText, imageBuffers, videoBuffer) {
  let embed = undefined;

  if (videoBuffer) {
    const videoUpload = await agent.uploadBlob(videoBuffer, { encoding: 'video/mp4' });
    embed = {
      $type: 'app.bsky.embed.media',
      media: {
        $type: 'app.bsky.embed.media#video',
        video: videoUpload.data.blob,
        alt: 'Video reposted from Mastodon'
      }
    };
  } else if (imageBuffers.length > 0) {
    const uploaded = [];
    for (const buffer of imageBuffers) {
      // Assume JPEG for processed images
      const upload = await agent.uploadBlob(buffer, { encoding: 'image/jpeg' });
      uploaded.push({
        $type: 'app.bsky.embed.images#image',
        image: upload.data.blob,
        alt: 'Media reposted from Mastodon',
      });
    }
    embed = {
      $type: 'app.bsky.embed.images',
      images: uploaded,
    };
  }

  await agent.post({
    text: richText.text,
    facets: richText.facets,
    embed,
  });
}

(async () => {
  try {
    const posts = await fetchMastodonPosts();
    // Oldest first
    const newPosts = posts.filter(post => !postedIds.includes(post.id)).reverse();
    if (newPosts.length === 0) {
      console.log('No new posts to repost.');
      return;
    }

    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD });

    for (const post of newPosts) {
      try {
        // Convert Mastodon HTML to RichText
        const richText = await mastodonToRichText(agent, post.content || post.spoiler_text || post.text || '');
        if (!richText || !richText.text) {
          console.warn(`Post ${post.id} has no text after cleaning, skipping.`);
          continue;
        }
        if (richText.text.length > BLUESKY_MAX_CHARS) {
          console.warn(`Post ${post.id} exceeds ${BLUESKY_MAX_CHARS} characters, skipping.`);
          continue;
        }

        const imageBuffers = [];
        let videoBuffer = null;
        let skipDueToVideo = false;

        if (post.media_attachments && post.media_attachments.length > 0) {
          for (const media of post.media_attachments) {
            try {
              if (media.type === 'image') {
                const buffer = await downloadMediaBuffer(media.url);
                const processedBuffer = await processImageBuffer(buffer);
                if (processedBuffer) {
                  imageBuffers.push(processedBuffer);
                } else {
                  console.warn(`Image skipped due to size/type limits.`);
                }
              } else if (media.type === 'video') {
                const buffer = await downloadMediaBuffer(media.url);
                if (buffer.length > BLUESKY_VIDEO_MAX_SIZE) {
                  console.warn(`Video is too large for BlueSky (>${BLUESKY_VIDEO_MAX_SIZE} bytes). Skipping post.`);
                  skipDueToVideo = true;
                } else {
                  videoBuffer = buffer;
                }
              }
            } catch (mediaErr) {
              console.error(`Failed to process media for post ${post.id}:`, mediaErr);
            }
          }
        }

        if (skipDueToVideo) {
          // Log as posted, but do not actually post to BlueSky
          postedIds.push(post.id);
          savePostedIds();
          console.log(`Skipped posting Mastodon post ${post.id} to BlueSky due to video size, but marked as posted.`);
          continue;
        }

        await postToBlueSky(agent, richText, imageBuffers, videoBuffer);

        postedIds.push(post.id);
        savePostedIds();

        console.log(`Reposted Mastodon post ${post.id} to BlueSky.`);
      } catch (postErr) {
        console.error(`Error processing post ${post.id}:`, postErr);
      }
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
