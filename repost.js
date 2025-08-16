const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { BskyAgent } = require('@atproto/api');

ffmpeg.setFfmpegPath(ffmpegPath);

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
const TEMP_MEDIA_DIR = path.join(os.tmpdir(), 'mastodon_media');
const BLUESKY_IMAGE_MAX_SIZE = 1024 * 1024; // 1MB
const BLUESKY_VIDEO_MAX_SIZE = 100 * 1024 * 1024; // 100MB

if (!fs.existsSync(TEMP_MEDIA_DIR)) {
  fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}

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

async function downloadMedia(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media: ${url}`);
  const filePath = path.join(TEMP_MEDIA_DIR, filename);
  const fileStream = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
  return filePath;
}

async function processImage(inputPath) {
  let outputPath = inputPath;
  let buffer = fs.readFileSync(inputPath);
  let metadata = await sharp(buffer).metadata();

  // Convert to JPEG if not JPEG/PNG
  let format = metadata.format;
  if (format !== 'jpeg' && format !== 'png') {
    outputPath = inputPath.replace(/\.[^/.]+$/, '.jpg');
    buffer = await sharp(buffer).jpeg().toBuffer();
    fs.writeFileSync(outputPath, buffer);
    format = 'jpeg';
  }

  // Compress/resize if over 1MB
  let size = buffer.length;
  if (size > BLUESKY_IMAGE_MAX_SIZE) {
    let quality = 90;
    while (size > BLUESKY_IMAGE_MAX_SIZE && quality > 10) {
      buffer = await sharp(buffer)
        .jpeg({ quality })
        .toBuffer();
      size = buffer.length;
      quality -= 10;
    }
    fs.writeFileSync(outputPath, buffer);
  }

  // Final check
  if (fs.statSync(outputPath).size > BLUESKY_IMAGE_MAX_SIZE) {
    console.warn(`Image ${inputPath} could not be compressed under 1MB, skipping.`);
    return null;
  }
  return outputPath;
}

async function processVideo(inputPath) {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '_bsky.mp4');
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-crf 28',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-vf scale=\'min(1280,iw)\':-2'
      ])
      .output(outputPath)
      .on('end', () => {
        if (fs.statSync(outputPath).size > BLUESKY_VIDEO_MAX_SIZE) {
          console.warn(`Video ${inputPath} could not be compressed under 100MB, skipping.`);
          fs.unlinkSync(outputPath);
          resolve(null);
        } else {
          resolve(outputPath);
        }
      })
      .on('error', (err) => {
        console.error(`ffmpeg error for ${inputPath}:`, err);
        resolve(null);
      })
      .run();
  });
}

async function fetchMastodonPosts() {
  const url = `${MASTODON_API_URL}/api/v1/accounts/${MASTODON_ACCOUNT_ID}/statuses?limit=5&exclude_replies=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Mastodon posts: ${res.statusText}`);
  return res.json();
}

async function postToBlueSky(agent, text, mediaFiles) {
  let embed = undefined;
  if (mediaFiles.length > 0) {
    const uploaded = [];
    for (const file of mediaFiles) {
      const data = fs.readFileSync(file);
      const mimeType = file.endsWith('.mp4')
        ? 'video/mp4'
        : file.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
      const upload = await agent.uploadBlob(data, { encoding: mimeType });
      if (mimeType.startsWith('image/')) {
        uploaded.push({
          $type: 'app.bsky.embed.images#image',
          image: upload.data.blob,
          alt: 'Media reposted from Mastodon',
        });
      } else if (mimeType === 'video/mp4') {
        embed = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: '', // BlueSky does not support direct video upload as of now, but this is a placeholder
            title: 'Video reposted from Mastodon',
            description: '',
            thumb: upload.data.blob,
          },
        };
      }
    }
    if (uploaded.length > 0) {
      embed = {
        $type: 'app.bsky.embed.images',
        images: uploaded,
      };
    }
  }

  await agent.post({
    text,
    embed,
  });
}

(async () => {
  try {
    const posts = await fetchMastodonPosts();
    const newPosts = posts.filter(post => !postedIds.includes(post.id));
    if (newPosts.length === 0) {
      console.log('No new posts to repost.');
      return;
    }

    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD });

    for (const post of newPosts.reverse()) {
      try {
        const text = post.content || post.spoiler_text || post.text || '';
        const mediaFiles = [];

        if (post.media_attachments && post.media_attachments.length > 0) {
          for (const media of post.media_attachments) {
            try {
              const ext = media.type === 'video' ? '.mp4' : path.extname(media.url) || '.jpg';
              const filename = `${post.id}_${media.id}${ext}`;
              const filePath = await downloadMedia(media.url, filename);

              let processedPath = null;
              if (media.type === 'image') {
                processedPath = await processImage(filePath);
              } else if (media.type === 'video') {
                processedPath = await processVideo(filePath);
              }

              if (processedPath) {
                mediaFiles.push(processedPath);
              } else {
                console.warn(`Media ${filename} skipped due to size/type limits.`);
              }

              if (processedPath && processedPath !== filePath) {
                fs.unlinkSync(filePath);
              }
            } catch (mediaErr) {
              console.error(`Failed to process media for post ${post.id}:`, mediaErr);
            }
          }
        }

        await postToBlueSky(agent, text, mediaFiles);

        postedIds.push(post.id);
        savePostedIds();

        for (const file of mediaFiles) {
          fs.unlinkSync(file);
        }

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
