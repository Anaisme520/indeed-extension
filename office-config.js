const STORAGE_KEY = 'officeId';

document.addEventListener('DOMContentLoaded', async () => {
  // Load existing value
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const existing = stored[STORAGE_KEY] || '';
  if (existing) {
    document.getElementById('officeId').value = existing;
    const el = document.getElementById('currentOffice');
    el.textContent = 'Current Office ID: ' + existing;
    el.classList.add('show');
  }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const officeId = document.getElementById('officeId').value.trim();
  const status = document.getElementById('status');

  if (!officeId) {
    status.textContent = 'Please enter a valid Office ID.';
    status.className = 'status error show';
    return;
  }

  try {
    console.log('Saving officeId:', officeId);
    // Save to storage
    await chrome.storage.local.set({ [STORAGE_KEY]: officeId });
    console.log('Saved to storage');

    // Also notify background.js
    chrome.runtime.sendMessage({
      type: 'setApiConfig',
      officeId: officeId,
    });

    // If queue was waiting, trigger resume
    chrome.runtime.sendMessage({ type: 'resumeQueueIfNeeded' });

    status.textContent = 'Office ID saved! You can now close this tab and start scraping.';
    status.className = 'status success show';

    const el = document.getElementById('currentOffice');
    el.textContent = 'Current Office ID: ' + officeId;
    el.classList.add('show');

    // Close tab after a short delay
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    status.textContent = 'Error saving: ' + e.message;
    status.className = 'status error show';
  }
});

// Allow Enter key
document.getElementById('officeId').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('saveBtn').click();
});
