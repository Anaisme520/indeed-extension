let total = 0;
let processed = 0;
let stored = 0;

const logEl = document.getElementById('log');
const progressFill = document.getElementById('progressFill');
const processedEl = document.getElementById('processedCount');
const storedEl = document.getElementById('storedCount');

function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function update() {
  const percent = total > 0 ? (processed / total) * 100 : 0;
  progressFill.style.width = `${percent}%`;
  processedEl.textContent = processed;
  storedEl.textContent = stored;
}

// Listen to background messages
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'resumeUploaded') {
    processed++;
    if (msg.data?.storedCandidatesCount) {
      stored += msg.data.storedCandidatesCount;
    }
    log(`Uploaded: ${msg.data.fileName || 'Resume'} (stored ${msg.data?.storedCandidatesCount || 0})`, 'success');
    update();
  } else if (msg.type === 'resumeUploadSkipped') {
    processed++;
    log(`Skipped: ${msg.data.fileName || 'Resume'} - ${msg.data.reason || 'Duplicate'}`, 'info');
    update();
  } else if (msg.type === 'resumeUploadFailed') {
    processed++;
    log(`Failed: ${msg.data.error || 'Unknown error'}`, 'error');
    update();
  } else if (msg.type === 'searchCountUpdated') {
    stored = msg.data.storedCandidatesCount || stored;
    update();
  } else if (msg.type === 'allCandidateProcessed') {
    log('All candidates processed!', 'success');
  } else if (msg.type === 'queueSize') {
    total = msg.data.total || 0;
    log(`Queue size: ${total}`, 'info');
    update();
  }
});

// Request initial queue size
chrome.runtime.sendMessage({ type: 'getQueueSize' }, (res) => {
  if (res?.total) {
    total = res.total;
    log(`Queue size: ${total}`, 'info');
    update();
  }
});

log('Progress page loaded', 'info');
