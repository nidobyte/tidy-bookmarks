// Runs in the background. Its only job: open the app page.

const APP_URL = chrome.runtime.getURL('app.html');

// Clicking the toolbar icon opens the app in a full tab
// (a popup would close as soon as the user clicks outside it).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: APP_URL });
});

// Open the app once right after installing, so new users see what it does.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: APP_URL });
});
