// version: v1.0 //

const { YoutubeTranscript } = require('youtube-transcript');
const { Innertube } = require('youtubei.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node index.js <youtube-url-or-id>');
    process.exit(1);
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    console.error('Could not extract video ID from:', url);
    process.exit(1);
  }

  console.log('Fetching video info...');
  const yt = await Innertube.create();
  const info = await yt.getBasicInfo(videoId);
  const title = info.basic_info.title || videoId;

  console.log(`Title: ${title}`);
  console.log('Fetching transcript...');

  const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
  const transcript = transcriptItems.map(item => item.text).join(' ');

  const safeTitle = title.replace(/[<>:"\/\\|?*]/g, '_').trim();
  const filename = `${safeTitle}.txt`;
  const outputPath = path.join(__dirname, filename);

  fs.writeFileSync(outputPath, transcript, 'utf-8');
  console.log(`Saved to: ${filename}`);
}

function extractVideoId(input) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
