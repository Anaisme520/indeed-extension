(function () {
  console.log("profileSearch.js loaded");

  const pickText = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return text;
    }
    return "";
  };

  const bodyText = document.body?.innerText || "";
  const emailMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = bodyText.match(
    /(?:\+?\d{1,3}\s?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/
  );
  const resumeLinkEl = document.querySelector('a[data-testid="download-resume-inline"]');

  chrome.runtime.sendMessage({
    type: "resumeFound",
    data: {
      blobUrl: resumeLinkEl?.getAttribute("href") || "",
      filename: resumeLinkEl?.getAttribute("download") || "resume.pdf",
      pageUrl: window.location.href,
      candidateData: {
        fullName: pickText(["h1", '[data-testid*="name"]', '[class*="name"]']),
        headline: pickText(['[data-testid*="headline"]', '[data-testid*="title"]']),
        address: pickText([
          '[data-testid*="location"]',
          '[data-testid*="address"]',
          'a[href*="maps"]',
          '[class*="location"]',
        ]),
        summary: pickText(['[data-testid*="summary"]', '[class*="summary"]']),
        email: emailMatch ? emailMatch[0] : "",
        phone: phoneMatch ? phoneMatch[0] : "",
      },
    },
  });
})();
