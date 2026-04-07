const STORAGE_KEYS = {
  processedLinks: "processedLinks",
  apiBaseUrl: "apiBaseUrl",
  authToken: "authToken",
  officeId: "officeId",
};

const DEFAULT_LOCAL_API_BASE_URL = "http://localhost:8000";
// const DEFAULT_LOCAL_API_BASE_URL = "https://staging-login.nurtureme.ai";
const DEFAULT_UPLOAD_PATH = "/api/upload-resume";
const PROFILE_WAIT_MS = 9000;
const TAB_CLOSE_DELAY_MS = 1200;
const AUTO_SCAN_DEBOUNCE_MS = 2500;

let queue = [];
let isRunning = false;
const autoScanTimers = new Map();

console.log("Background script loaded");

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message?.type === "startQueue") {
    void handleStartQueue(message, sendResponse);
    return true;
  }

  if (message?.type === "resumeQueueIfNeeded") {
    console.log('resumeQueueIfNeeded received, isRunning:', isRunning, 'queue.length:', queue.length);
    const officeId = await getOfficeId();
    console.log('Current officeId:', officeId);
    if (!isRunning && queue.length > 0 && !officeId) {
      // Still no office_id, ignore
      console.log('Office ID still not set, ignoring resume');
      sendResponse({ status: 'error', message: 'Office ID still not set' });
      return true;
    }
    if (!isRunning && queue.length > 0) {
      console.log('Resuming queue processing');
      isRunning = true;
      processQueue();
      sendResponse({ status: 'ok', message: 'Resuming queue' });
    } else {
      console.log('No queue to resume or already running');
      sendResponse({ status: 'ok', message: 'No queue to resume or already running' });
    }
    return true;
  }

  if (message?.type === "setApiConfig") {
    void handleSetApiConfig(message, sendResponse);
    return true;
  }

  if (message?.type === "resetSearchProgress" || message?.type === "resetScrapeProgress") {
    void handleResetProgress(sendResponse);
    return true;
  }

  // Backward-compatible path in case an old content script sends this message.
  if (message?.type === "resumeFound") {
    void handleResumeUploadMessage(message?.data ?? {});
  }

  return false;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  try {
    if (message && message.type === "ping_extension") {
      const manifest = chrome.runtime.getManifest();
      sendResponse({ installed: true, version: manifest.version, name: manifest.name });
    }
  } catch (_err) {
    // Ignore external ping failures.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isIndeedCandidatesUrl(tab?.url)) return;

  const existingTimer = autoScanTimers.get(tabId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    autoScanTimers.delete(tabId);
    void enqueueCandidatesFromTab(tabId);
  }, AUTO_SCAN_DEBOUNCE_MS);

  autoScanTimers.set(tabId, timer);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const timer = autoScanTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  autoScanTimers.delete(tabId);
});

async function handleStartQueue(message, sendResponse) {
  try {
    const links = Array.isArray(message?.links) ? message.links.filter(Boolean) : [];
    const alreadyProcessed = await getProcessedLinkSet();
    queue = links.filter((link) => !alreadyProcessed.has(link));

    if (!isRunning) {
      isRunning = true;
      void processQueue();
    }

    sendResponse({
      status: "Queue started",
      totalReceived: links.length,
      pendingToProcess: queue.length,
      skippedAlreadyProcessed: links.length - queue.length,
    });
  } catch (error) {
    console.error("Failed to start queue:", error);
    sendResponse({ status: "error", message: String(error) });
  }
}

async function handleSetApiConfig(message, sendResponse) {
  try {
    console.log('handleSetApiConfig received:', message);
    const updates = {};
    if (typeof message?.apiBaseUrl === "string" && message.apiBaseUrl.trim()) {
      updates[STORAGE_KEYS.apiBaseUrl] = message.apiBaseUrl.trim().replace(/\/+$/, "");
    }
    if (typeof message?.authToken === "string") {
      updates[STORAGE_KEYS.authToken] = message.authToken.trim();
    }
    if (typeof message?.officeId === "string" && message.officeId.trim()) {
      updates[STORAGE_KEYS.officeId] = message.officeId.trim();
      console.log('Setting officeId:', message.officeId);
    }
    await storageSet(updates);
    console.log('Storage updated:', updates);
    sendResponse({ status: "ok" });
  } catch (error) {
    console.error("Failed to set API config:", error);
    sendResponse({ status: "error", message: String(error) });
  }
}

async function handleResetProgress(sendResponse) {
  try {
    await storageSet({ [STORAGE_KEYS.processedLinks]: [] });
    queue = [];
    isRunning = false;
    sendResponse({ status: "ok" });
  } catch (error) {
    console.error("Failed to reset search progress:", error);
    sendResponse({ status: "error", message: String(error) });
  }
}

async function ensureOfficeId() {
  const token = await getAuthToken();
  if (token) return true; // Auth token present, backend will resolve office_id from user

  const officeId = await getOfficeId();
  if (officeId) return true; // Office ID already configured

  // No auth and no office_id — open config page and wait
  console.warn("No auth token and no office_id configured. Opening office config page.");
  const configUrl = chrome.runtime.getURL("office-config.html");
  await chrome.tabs.create({ url: configUrl, active: true });

  // Wait for office_id to be set (poll storage, max 2 minutes)
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const id = await getOfficeId();
    if (id) return true;
  }
  return false;
}

async function processQueue() {
  // Ensure office_id is available before processing
  const hasOffice = await ensureOfficeId();
  if (!hasOffice) {
    console.error("Office ID not provided. Aborting queue processing.");
    chrome.runtime.sendMessage({
      type: "resumeUploadFailed",
      data: { pageUrl: "", error: "Office ID is required. Please configure it and try again." },
    });
    isRunning = false;
    return;
  }

  // Open progress page
  const progressUrl = chrome.runtime.getURL('progress.html');
  await chrome.tabs.create({ url: progressUrl, active: true });

  // Send initial queue size
  chrome.runtime.sendMessage({ type: 'queueSize', data: { total: queue.length } });

  while (queue.length > 0) {
    const profileUrl = queue.shift();
    if (!profileUrl) continue;

    try {
      const profileData = await searchProfileFromTab(profileUrl);
      const uploadResult = await uploadResumeWithProfileData(profileData);
      const storedCandidatesCount = Number(uploadResult?.storedCandidatesCount || 0);

      await markLinkAsProcessed(profileUrl);
      
      // If candidate was skipped (duplicate), still update badge but don't count as stored
      if (uploadResult?.skipped) {
        chrome.runtime.sendMessage({
          type: "resumeUploadSkipped",
          data: {
            fileName: uploadResult?.fileName || "",
            link: uploadResult?.link || "",
            pageUrl: profileData.pageUrl,
            candidateData: profileData.candidateData,
            reason: uploadResult?.message || 'Duplicate',
          },
        });
      } else {
        updateExtensionBadgeCount(storedCandidatesCount);
        chrome.runtime.sendMessage({
          type: "resumeUploaded",
          data: {
            fileName: uploadResult?.fileName || "",
            link: uploadResult?.link || "",
            pageUrl: profileData.pageUrl,
            candidateData: profileData.candidateData,
            hasResume: Boolean(profileData.resume?.blobUrl),
            storedCandidatesCount,
          },
        });
        chrome.runtime.sendMessage({
          type: "searchCountUpdated",
          data: { storedCandidatesCount },
        });
      }
    } catch (error) {
      console.error("Failed processing candidate:", profileUrl, error);
      // Do not mark failed links as processed so they can retry on the next run.
      chrome.runtime.sendMessage({
        type: "resumeUploadFailed",
        data: { pageUrl: profileUrl, error: String(error) },
      });
    }
  }

  isRunning = false;
  chrome.runtime.sendMessage({ type: "allCandidateProcessed", data: {} });
}

async function enqueueCandidatesFromTab(tabId) {
  try {
    const links = await extractCandidateLinksFromTab(tabId);
    if (!links.length) return;

    const alreadyProcessed = await getProcessedLinkSet();
    const pending = links.filter((link) => !alreadyProcessed.has(link) && !queue.includes(link));
    if (!pending.length) return;

    queue.push(...pending);

    chrome.runtime.sendMessage({
      type: "backgroundQueueUpdated",
      data: {
        discovered: links.length,
        enqueued: pending.length,
        pendingTotal: queue.length,
      },
    });

    if (!isRunning) {
      isRunning = true;
      void processQueue();
    }
  } catch (error) {
    console.warn("Auto queue scan failed:", error);
  }
}

async function extractCandidateLinksFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      // Function to click load more/show more buttons
      async function loadAllCandidates() {
        let previousCount = 0;
        let attempts = 0;
        const maxAttempts = 50; // Prevent infinite loops
        
        while (attempts < maxAttempts) {
          // Look for various load more button patterns
          const loadMoreSelectors = [
            'button[aria-label*="Load more"]',
            'button[aria-label*="Show more"]',
            'button:contains("Load more")',
            'button:contains("Show more")',
            'a:contains("Load more")',
            'a:contains("Show more")',
            '.load-more',
            '.show-more',
            '[data-testid*="load-more"]',
            '[data-testid*="show-more"]',
            'button[class*="load"]',
            'button[class*="more"]'
          ];
          
          let loadMoreButton = null;
          for (const selector of loadMoreSelectors) {
            const button = document.querySelector(selector);
            if (button && (button.offsetParent !== null || getComputedStyle(button).display !== 'none')) {
              loadMoreButton = button;
              break;
            }
          }
          
          // Also check for pagination next buttons
          const nextButton = document.querySelector('a[aria-label="Next"], button[aria-label="Next"], .pagination-next, .next-page');
          
          if (!loadMoreButton && !nextButton) {
            // No more buttons to click
            break;
          }
          
          // Count current candidates
          const currentLinks = Array.from(document.querySelectorAll("a[href]"))
            .map(a => a.href)
            .filter(href => href.includes("/candidates/view?id="));
          
          if (currentLinks.length === previousCount) {
            // No new candidates loaded, stop trying
            break;
          }
          
          previousCount = currentLinks.length;
          
          // Click the button
          try {
            if (loadMoreButton) {
              loadMoreButton.click();
            } else if (nextButton) {
              nextButton.click();
            }
            
            // Wait for content to load
            await new Promise(resolve => setTimeout(resolve, 1500));
          } catch (e) {
            console.log('Error clicking load more button:', e);
            break;
          }
          
          attempts++;
        }
      }
      
      // Load all candidates first
      await loadAllCandidates();
      
      // Now extract all candidate links
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const links = anchors
        .map((a) => {
          try {
            return new URL(a.href, window.location.href).toString();
          } catch (_err) {
            return "";
          }
        })
        .filter((href) => href.includes("/candidates/view?id="));

      return Array.from(new Set(links));
    },
  });

  return Array.isArray(result?.result) ? result.result : [];
}

function isIndeedCandidatesUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.hostname !== "employers.indeed.com") return false;
    return u.pathname === "/candidates" || u.pathname.startsWith("/candidates/");
  } catch (_error) {
    return false;
  }
}

async function searchProfileFromTab(profileUrl) {
  const tab = await tabsCreate({ url: profileUrl, active: false });
  const tabId = tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Unable to open candidate tab");
  }

  try {
    await waitForTabComplete(tabId, 30000);
    await sleep(PROFILE_WAIT_MS);

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const unique = (arr) => Array.from(new Set(arr.filter(Boolean)));
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isLikelyName = (value) => {
          const v = clean(value);
          if (!v || v.length < 3) return false;
          if (/^candidates?$/i.test(v)) return false;
          if (/^anonymous$/i.test(v)) return false;
          if (/^experience$/i.test(v)) return false;
          if (/^screener questions?$/i.test(v)) return false;
          if (/^professional summary$/i.test(v)) return false;
          if (/^cover letter$/i.test(v)) return false;
          if (/^certifications? and licences?$/i.test(v)) return false;
          if (/all candidates/i.test(v)) return false;
          if (/all open and paused jobs/i.test(v)) return false;
          if (/^back to list$/i.test(v)) return false;
          if (/status|reviewing|accepts push|activity feed|interviews?|notifications?|messages?/i.test(v)) return false;
          if (v.includes("•")) return false;
          if (/\d{3,}/.test(v)) return false;
          const words = v.split(" ").filter(Boolean);
          if (words.length < 2 || words.length > 6) return false;
          return /^[A-Za-z.'\- ]+$/.test(v);
        };
        const likelyNameFromLines = (sourceLines) => {
          for (const line of sourceLines) {
            if (isLikelyName(line)) {
              const words = line.split(" ").filter(Boolean);
              if (words.length >= 2 && words.length <= 6) {
                return line;
              }
            }
          }
          return "";
        };
        const pickText = (selectors, root = document) => {
          for (const selector of selectors) {
            const el = root.querySelector(selector);
            const text = clean(el?.textContent);
            if (text) return text;
          }
          return "";
        };
        const pickAllText = (selectors, root = document) =>
          unique(
            selectors.flatMap((selector) =>
              Array.from(root.querySelectorAll(selector))
                .map((el) => clean(el.textContent))
                .filter(Boolean)
            )
          );
        const isLikelyAddress = (value) => {
          const v = clean(value);
          if (!v) return false;
          if (v.includes("•")) return false;
          if (/manager|engineer|director|assistant|developer|marketing|sales|confidential/i.test(v)) return false;
          return (
            /\b[A-Za-z .'-]+,\s*[A-Za-z .'-]+(?:,\s*[A-Z]{2})?(?:\s+\d{5})?\b/.test(v) ||
            /\b[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}\b/.test(v)
          );
        };
        const pickEmail = (root, bodyText) => {
          const mailto = Array.from(root.querySelectorAll('a[href^="mailto:"]'))
            .map((a) => clean((a.getAttribute("href") || "").replace(/^mailto:/i, "")))
            .filter(Boolean);
          if (mailto.length) return mailto[0];

          const allMatches = unique(bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
          const headerEmails = unique(
            bodyText
              .split("\n")
              .slice(0, 25)
              .flatMap((line) => line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
          );
          return allMatches.find((email) => !headerEmails.includes(email)) || "";
        };
        const pickPhone = (root, bodyText) => {
          const tel = Array.from(root.querySelectorAll('a[href^="tel:"]'))
            .map((a) => clean((a.getAttribute("href") || "").replace(/^tel:/i, "")))
            .filter(Boolean);
          if (tel.length) return tel[0];
          const phoneMatch = bodyText.match(/(?:\+?\d{1,3}\s?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
          return phoneMatch ? phoneMatch[0] : "";
        };
        const extractCandidateData = () => {
          const getNameFromSelectedCard = () => {
            try {
              const currentUrl = new URL(window.location.href);
              const candidateId = currentUrl.searchParams.get("id");
              if (!candidateId) return "";

              const anchors = Array.from(document.querySelectorAll("a[href]"));
              const matchedAnchor = anchors.find((a) => {
                const href = a.getAttribute("href") || "";
                return href.includes(`id=${candidateId}`);
              });
              if (!matchedAnchor) return "";

              const cardContainer =
                matchedAnchor.closest("li, article, [role='listitem'], [class*='candidate'], [class*='card']") ||
                matchedAnchor;
              const cardLines = clean(cardContainer.textContent || "")
                .split(/(?=[A-Z][a-z])|\n/)
                .map((line) => clean(line))
                .filter(Boolean);

              const candidateName = cardLines.find((line) => isLikelyName(line));
              return candidateName || "";
            } catch (_err) {
              return "";
            }
          };

          const mainRoot =
            document.querySelector('main, [data-testid*="candidate"], [class*="candidate-profile"], [class*="candidateDetail"]') ||
            document.body;
          const bodyText = mainRoot?.innerText || document.body?.innerText || "";
          const lines = bodyText
            .split("\n")
            .map((line) => clean(line))
            .filter(Boolean);

          const headingCandidates = unique(
            [
              ...pickAllText(
                [
                  '[data-testid="candidate-name"]',
                  '[data-testid*="candidateName"]',
                  '[class*="candidateName"]',
                  'main h1',
                  'main h2',
                  'section h1',
                  'section h2',
                ],
                mainRoot
              ),
              ...pickAllText(['main h1', 'main h2'], document),
            ]
          );
          const backToListIndex = lines.findIndex((line) => /back to list/i.test(line));
          const contextualLines =
            backToListIndex >= 0 ? lines.slice(backToListIndex + 1, backToListIndex + 15) : lines.slice(0, 120);
          // Prefer explicit name nodes (h1 / data-testid) before list-card scraping.
          // Card text often includes the job title (e.g. "Sales Manager") ahead of the person name.
          const inferredName =
            headingCandidates.find(isLikelyName) ||
            getNameFromSelectedCard() ||
            likelyNameFromLines(contextualLines) ||
            likelyNameFromLines(lines.slice(0, 120)) ||
            "";

          const headlineCandidates = unique(
            [
              ...pickAllText(
                [
                  '[data-testid*="headline"]',
                  '[data-testid*="title"]',
                  '[class*="headline"]',
                  '[class*="jobTitle"]',
                  'main h3',
                ],
                mainRoot
              ),
              ...contextualLines,
            ].filter((v) => v && v !== inferredName)
          );
          const inferredHeadline =
            headlineCandidates.find(
              (v) => v.includes("•") || /manager|engineer|director|assistant|developer|sales|marketing|confidential/i.test(v)
            ) || "";

          const addressCandidates = unique(
            [
              ...pickAllText(
                [
                  '[data-testid*="location"]',
                  '[data-testid*="address"]',
                  '[aria-label*="Location"]',
                  '[aria-label*="location"]',
                  '[class*="candidate"][class*="location"]',
                  'a[href*="maps"]',
                  '[class*="location"]',
                ],
                mainRoot
              ),
              ...contextualLines,
            ]
          );
          const inferredAddress = addressCandidates.find(isLikelyAddress) || "";

          const summaryFromSelectors = pickText(
            [
              '[data-testid*="summary"]',
              '[data-testid*="about"]',
              '[class*="summary"]',
              '[class*="about"]',
            ],
            mainRoot
          );
          const summaryFromText =
            lines.find(
              (line) =>
                line.length > 80 &&
                !/@/.test(line) &&
                !/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(line) &&
                !isLikelyAddress(line)
            ) || "";

          const inferAppliedFor = () => {
            const activityMatch = bodyText.match(/submitted an application for\s+([^\n.]+?)(?:\.|\s+on\s|\s*$)/i);
            if (activityMatch) {
              const role = clean(activityMatch[1]);
              if (role.length >= 2 && role.length < 200) return role;
            }

            if (inferredHeadline) {
              const beforeBullet = clean(inferredHeadline.split(/\s*[•·]\s*/)[0] || "");
              if (beforeBullet.length >= 2 && beforeBullet.length < 200) return beforeBullet;
              const whole = clean(inferredHeadline);
              if (whole.length >= 2 && whole.length < 200) return whole;
            }

            try {
              const currentUrl = new URL(window.location.href);
              const candidateId = currentUrl.searchParams.get("id");
              if (!candidateId) return "";

              const matchedAnchor = Array.from(document.querySelectorAll("a[href]")).find((a) => {
                const href = a.getAttribute("href") || "";
                return href.includes(`id=${candidateId}`);
              });
              if (!matchedAnchor) return "";

              const cardContainer =
                matchedAnchor.closest("li, article, [role='listitem'], [class*='candidate'], [class*='card']") ||
                matchedAnchor;
              const cardLines = clean(cardContainer.textContent || "")
                .split(/\n/)
                .map((line) => clean(line))
                .filter(Boolean);

              for (const line of cardLines) {
                if (line === inferredName) continue;
                if (!/[·•]/.test(line)) continue;
                const jobPart = clean(line.split(/[·•]/)[0] || "");
                if (!jobPart || jobPart.length < 2 || jobPart.length > 120) continue;
                if (/^reviewing$/i.test(jobPart)) continue;
                if (isLikelyAddress(line)) continue;
                if (isLikelyName(jobPart)) continue;
                return jobPart;
              }
            } catch (_err) {
              return "";
            }

            return "";
          };

          const appliedFor = inferAppliedFor();

          return {
            fullName: inferredName,
            headline: inferredHeadline,
            appliedFor,
            address: inferredAddress,
            summary: summaryFromSelectors || summaryFromText,
            email: pickEmail(mainRoot, bodyText),
            phone: pickPhone(mainRoot, bodyText),
          };
        };

        const resumeLinkEl = document.querySelector('a[data-testid="download-resume-inline"]');
        const resumeBlobUrl = resumeLinkEl?.getAttribute("href") || "";
        const resumeFilename = resumeLinkEl?.getAttribute("download") || "resume.pdf";
        let resumeFileBase64 = "";
        let resumeMimeType = "application/pdf";

        if (resumeBlobUrl) {
          try {
            const absoluteResumeUrl = new URL(resumeBlobUrl, window.location.href).toString();
            const resumeResponse = await fetch(absoluteResumeUrl, { credentials: "include" });
            if (resumeResponse.ok) {
              const resumeBlob = await resumeResponse.blob();
              resumeMimeType = resumeBlob.type || "application/pdf";
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(String(reader.result || ""));
                reader.onerror = reject;
                reader.readAsDataURL(resumeBlob);
              });
              if (dataUrl.startsWith("data:")) {
                resumeFileBase64 = dataUrl.split(",")[1] || "";
              }
            }
          } catch (_error) {
            // Keep metadata fallback when binary fetch fails.
          }
        }

        let candidateData = extractCandidateData();
        const startedAt = Date.now();
        while (!candidateData.fullName && Date.now() - startedAt < 12000) {
          await delay(500);
          candidateData = extractCandidateData();
        }

        return {
          pageUrl: window.location.href,
          resume: {
            blobUrl: resumeBlobUrl,
            filename: resumeFilename,
            fileBase64: resumeFileBase64,
            mimeType: resumeMimeType,
          },
          candidateData,
        };
      },
    });

    return result?.result || { pageUrl: profileUrl, resume: { blobUrl: "", filename: "" }, candidateData: {} };
  } finally {
    await sleep(TAB_CLOSE_DELAY_MS);
    await tabsRemove(tabId);
  }
}

// Check if candidate already exists by name or email
async function candidateExists(name, email) {
  try {
    const endpoint = await getUploadEndpoint();
    const token = await getAuthToken();
    const officeId = await getOfficeId();
    
    const response = await fetch(`${endpoint}/check-candidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      },
      body: JSON.stringify({ name, email, office_id: officeId })
    });
    
    if (response.ok) {
      const result = await response.json();
      return result.exists === true;
    }
  } catch (e) {
    console.warn('Failed to check candidate existence:', e);
  }
  return false;
}

async function uploadResumeWithProfileData(profileData) {
  const hasResume = Boolean(profileData?.resume?.blobUrl);
  const endpoint = await getUploadEndpoint();
  const token = await getAuthToken();
  const officeId = await getOfficeId();
  
  // Check for duplicates by name/email
  const candidateName = profileData?.candidateData?.fullName || '';
  const candidateEmail = profileData?.candidateData?.email || '';
  if (candidateName || candidateEmail) {
    const exists = await candidateExists(candidateName, candidateEmail);
    if (exists) {
      console.log('Candidate already exists, skipping:', candidateName, candidateEmail);
      return { success: false, message: 'Candidate already exists', skipped: true };
    }
  }
  const formData = new FormData();
  formData.append("resourceType", "indeed");
  formData.append("candidateData", JSON.stringify(profileData?.candidateData || {}));
  formData.append("profileUrl", profileData?.pageUrl || "");
  if (officeId) {
    formData.append("office_id", officeId);
  }

  if (hasResume) {
    try {
      if (profileData?.resume?.fileBase64) {
        const resumeBlob = base64ToBlob(profileData.resume.fileBase64, profileData?.resume?.mimeType || "application/pdf");
        formData.append("file", resumeBlob, profileData.resume.filename || "resume.pdf");
      } else {
        const resumeUrl = new URL(profileData.resume.blobUrl, profileData?.pageUrl || undefined).toString();
        const resumeResponse = await fetch(resumeUrl, { credentials: "include" });
        if (resumeResponse.ok) {
          const resumeBlob = await resumeResponse.blob();
          formData.append("file", resumeBlob, profileData.resume.filename || "resume.pdf");
        } else {
          console.warn("Resume fetch skipped with non-200 response:", resumeResponse.status);
        }
      }
    } catch (resumeError) {
      // Continue metadata upload even if resume binary download fails.
      console.warn("Resume fetch failed; uploading candidate metadata only.", resumeError);
    }
  }

  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed (${response.status}): ${errorText}`);
  }

  const body = await response.json().catch(() => ({}));
  return {
    fileName: body?.data?.fileName || "",
    link: body?.data?.filePathUrl || "",
    storedCandidatesCount: Number(body?.data?.storedCandidatesCount || 0),
  };
}

async function handleResumeUploadMessage(data) {
  try {
    const profileData = {
      pageUrl: data.pageUrl || "",
      resume: {
        blobUrl: data.blobUrl || "",
        filename: data.filename || "resume.pdf",
      },
      candidateData: data.candidateData || {},
    };
    await uploadResumeWithProfileData(profileData);
  } catch (error) {
    console.error("Legacy resume upload failed:", error);
  }
}

async function getUploadEndpoint() {
  const { [STORAGE_KEYS.apiBaseUrl]: savedBaseUrl } = await storageGet([STORAGE_KEYS.apiBaseUrl]);
  const baseUrl = (savedBaseUrl || DEFAULT_LOCAL_API_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}${DEFAULT_UPLOAD_PATH}`;
}

async function getAuthToken() {
  const { [STORAGE_KEYS.authToken]: token } = await storageGet([STORAGE_KEYS.authToken]);
  return typeof token === "string" ? token : "";
}

async function getOfficeId() {
  const { [STORAGE_KEYS.officeId]: officeId } = await storageGet([STORAGE_KEYS.officeId]);
  return typeof officeId === "string" ? officeId : "";
}

async function getProcessedLinkSet() {
  const { [STORAGE_KEYS.processedLinks]: processedLinks = [] } = await storageGet([STORAGE_KEYS.processedLinks]);
  return new Set(Array.isArray(processedLinks) ? processedLinks : []);
}

async function markLinkAsProcessed(link) {
  const processedSet = await getProcessedLinkSet();
  processedSet.add(link);
  await storageSet({ [STORAGE_KEYS.processedLinks]: Array.from(processedSet) });
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      // Ignore close errors (tab may already be closed).
      resolve();
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Tab load timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateExtensionBadgeCount(count) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== "function") {
    return;
  }
  const badgeText = count > 0 ? String(count) : "";
  chrome.action.setBadgeBackgroundColor({ color: "#2557A7" });
  chrome.action.setBadgeText({ text: badgeText });
}

function base64ToBlob(base64, mimeType) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "application/pdf" });
}
