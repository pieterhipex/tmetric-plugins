class ChromeExtension extends ExtensionBase {
    loginTabId: number;

    loginWinId: number;

    loginWindowPending: boolean;

    checkCloseTimeout: number;

    lastNotificationId: string;

    constructor() {
        super(backgroundPort);

        // Inject content scripts in all already opened pages
        var contentScripts = (<ChromeExtensionManifest>chrome.runtime.getManifest()).content_scripts[0];
        var jsFiles = contentScripts.js;
        var cssFiles = contentScripts.css;
        var runAt = contentScripts.run_at;
        chrome.tabs.query({}, tabs =>
            tabs.forEach(tab => {
                if (tab.url.indexOf('http') == 0) {
                    jsFiles.forEach(file => chrome.tabs.executeScript(tab.id, { file, runAt }));
                    cssFiles.forEach(file => chrome.tabs.insertCSS(tab.id, { file }));
                }
            }));

        this.sendToTabs = (message, tabId?) => {
            if (tabId != null) {
                chrome.tabs.sendMessage(tabId, message);
            }
            else {
                chrome.tabs.query({}, tabs => tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, message);
                }));
            }
        }
        chrome.runtime.onMessage.addListener((message: ITabMessage | IPopupRequest, sender: chrome.runtime.MessageSender, senderResponse: (IPopupResponse) => void) => {
            if (sender.tab) {
                if (sender.tab.id == this.loginTabId) { // Ignore login dialog
                    return;
                }
                var tabId = sender.tab.id;
                var isActive = sender.tab.active;
                this.onTabMessage(message, tabId, isActive);
            } else if (sender.url && sender.url.match(/^chrome.+popup.html$/)) {
                this.onPopupRequest(message, senderResponse);
                // http://stackoverflow.com/questions/33614911/sending-message-between-content-js-and-background-js-fails
                return !!senderResponse;
            }
        });

        chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
            if (tabId == this.loginTabId) {
                this.loginTabId = null;
                this.loginWinId = null;
                this.reconnect();
            }

            if (this.checkCloseTimeout) {
                clearTimeout(this.checkCloseTimeout);
            }

            this.checkCloseTimeout = setTimeout(() => {
                this.checkCloseTimeout = null;
                chrome.tabs.query({}, tabs => {
                    var allUrls = tabs.map(tab => tab.url);
                    this.cleanUpTabInfo(allUrls);
                });
            }, 60000);
        });

        var updateCurrentTab = (canReset?: boolean) => {
            chrome.tabs.query({ lastFocusedWindow: true, active: true }, tabs => {
                var tab = tabs[0];
                if (tab) {
                    if (tab.id != this.loginTabId) {
                        this.setCurrentTab(tab.url, tab.title);
                    }
                }
                else if (canReset) {
                    this.setCurrentTab(null, null);
                }
            });
        };

        chrome.runtime.onMessageExternal.addListener((request: any, sender: any, sendResponse: Function) => {
            if (request.message == "version") {
                sendResponse({ version: "0.1.0" });
            }
        });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {

            if (tabId == this.loginTabId && changeInfo.url) {
                var tabUrl = changeInfo.url.toLowerCase();
                var serviceUrl = trackerServiceUrl.toLowerCase();
                if (tabUrl == serviceUrl || tabUrl.indexOf(serviceUrl + '#') == 0) {
                    chrome.tabs.remove(tabId);
                    return;
                }
            }

            updateCurrentTab();
        });

        // When user switch windows, tabs.onUpdated does not fire
        chrome.windows.onFocusChanged.addListener(() => updateCurrentTab());

        chrome.tabs.onActivated.addListener(activeInfo => {
            updateCurrentTab(true);
        });

        updateCurrentTab();

        // Update hint once per minute
        var setUpdateTimeout = () => setTimeout(() => {
            this.updateState();
            setUpdateTimeout();
        }, (60 - new Date().getSeconds()) * 1000);
        setUpdateTimeout();
    }

    showError(message: string) {
        alert(message);
    }

    showNotification(message: string, title?: string) {
        if (this.lastNotificationId) {
            chrome.notifications.clear(this.lastNotificationId, () => { });
        }
        title = title || 'TMetric';
        var type = 'basic';
        var iconUrl = 'images/icon.png';
        chrome.notifications.create(
            null,
            { title, message, type, iconUrl },
            id => this.lastNotificationId = id);
    }

    showConfirmation(message: string) {
        return confirm(message);
    }

    loadValue(key: string, callback: (value: any) => void) {
        chrome.storage.sync.get(key, obj => {
            var value;
            if (obj) {
                value = obj[key];
            }
            callback(value);
        });
    }

    saveValue(key: string, value: any) {
        var obj = {};
        obj[key] = value;
        chrome.storage.sync.set(obj);
    }

    showLoginDialog() {
        if (this.loginWinId) {
            chrome.windows.update(this.loginWinId, { focused: true });
            return;
        }

        chrome.windows.getLastFocused(window => {
            if (this.loginWindowPending) {
                return;
            }
            this.loginWindowPending = true;
            try {
                var width = 450;
                var height = 540;
                var left = 400;
                var top = 300;

                if (window.left != null && window.width != null) {
                    left = Math.round(window.left + (window.width - width) / 2);
                }
                if (window.top != null && window.height != null) {
                    top = Math.round(window.top + (window.height - height) / 2);
                }

                chrome.windows.create(
                    <chrome.windows.CreateData>{
                        left,
                        top,
                        width,
                        height,
                        focused: true,
                        url: this.getLoginUrl(),
                        type: 'popup'
                    }, window => {
                        this.loginWinId = window.id;
                        this.loginTabId = window.tabs[0].id;
                        this.loginWindowPending = false;
                    });
            }
            catch (e) {
                this.loginWindowPending = false;
            }
        });
    }

    setButtonIcon(icon: string, tooltip: string) {
        chrome.browserAction.setIcon({
            path: {
                '19': 'images/chrome/' + icon + '19.png',
                '38': 'images/chrome/' + icon + '38.png'
            }
        });
        chrome.browserAction.setTitle({ title: tooltip });
    }

    openPage(url: string) {
        chrome.tabs.query({ active: true, windowId: chrome.windows.WINDOW_ID_CURRENT }, tabs => {

            var currentWindowId = tabs && tabs.length && tabs[0].windowId;

            // chrome.tabs.query do not support tab search with hashed urls
            // https://developer.chrome.com/extensions/match_patterns
            chrome.tabs.query({ url: url.split('#')[0] }, tabs => {
                // filter tabs queried without hashes by actual url
                var pageTabs = tabs.filter(tab => tab.url == url);
                if (pageTabs.length) {

                    var anyWindowTab: chrome.tabs.Tab, anyWindowActiveTab: chrome.tabs.Tab, currentWindowTab: chrome.tabs.Tab, currentWindowActiveTab: chrome.tabs.Tab;
                    for (let index = 0, size = pageTabs.length; index < size; index += 1) {
                        anyWindowTab = pageTabs[index];
                        if (anyWindowTab.active) {
                            anyWindowActiveTab = anyWindowTab;
                        }
                        if (anyWindowTab.windowId == currentWindowId) {
                            currentWindowTab = anyWindowTab;
                            if (currentWindowTab.active) {
                                currentWindowActiveTab = currentWindowTab;
                            }
                        }
                    }

                    var tabToActivate = currentWindowActiveTab || currentWindowTab || anyWindowActiveTab || anyWindowTab;
                    chrome.windows.update(tabToActivate.windowId, { focused: true });
                    chrome.tabs.update(tabToActivate.id, { active: true });
                } else {
                    chrome.tabs.create({ active: true, windowId: currentWindowId, url });
                }
            });
        });
    }
}

new ChromeExtension();