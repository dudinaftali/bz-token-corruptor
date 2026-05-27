const TOKEN_PATTERNS = [
    /^x-bz-refresh-attendee-token-.+$/,
    /^x-bz-access-attendee-token-.+$/
];

const STORAGE_KEY = "bz_original_tokens";

function isTokenCookie(name) {
    return TOKEN_PATTERNS.some(p => p.test(name));
}

function setStatus(msg) {
    document.getElementById("status").textContent = msg;
}

function showCorruptedTokens(cookies) {
    const list = document.getElementById("tokenList");
    list.innerHTML = "";
    if (!cookies || cookies.length === 0) {
        list.style.display = "none";
        return;
    }
    cookies.forEach(c => {
        const item = document.createElement("div");
        item.className = "token-item";
        const truncated = c.value.length > 40 ? c.value.slice(0, 40) + "…" : c.value;
        item.innerHTML = `<div class="token-name">${c.name}</div><div class="token-value">a${truncated}</div>`;
        list.appendChild(item);
    });
    list.style.display = "block";
}

async function getAllTokenCookies(envFilter) {
    return new Promise(resolve => {
        chrome.cookies.getAll({}, cookies => {
            let matches = cookies.filter(c => isTokenCookie(c.name));
            if (envFilter) {
                matches = matches.filter(c => c.name.toLowerCase().includes(envFilter.toLowerCase()));
            }
            matches = matches.filter(c => c.value && c.value !== "undefined");
            resolve(matches);
        });
    });
}

async function setCookie(cookie, value) {
    return new Promise(resolve => {
        const url = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
        const details = {
            url,
            name: cookie.name,
            value,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expirationDate,
            sameSite: cookie.sameSite,
            storeId: cookie.storeId
        };
        // Only set domain for host-only cookies (no leading dot)
        if (!cookie.hostOnly) {
            details.domain = cookie.domain;
        }
        chrome.cookies.set(details, resolve);
    });
}

async function corruptCookies(envFilter) {
    const cookies = await getAllTokenCookies(envFilter);
    if (cookies.length === 0) {
        setStatus(envFilter ? `No tokens found for "${envFilter}".` : "No matching tokens found.");
        return;
    }

    // Always overwrite saved originals with the current scan (fresh state each time)
    const existing = await chrome.storage.local.get(STORAGE_KEY);
    const originals = existing[STORAGE_KEY] || {};
    cookies.forEach(c => {
        const key = [c.name, c.domain, c.path, c.storeId].join("|");
        // Only save original if not already corrupted (i.e. not previously saved)
        if (!originals[key]) {
            originals[key] = { cookie: c, value: c.value };
        }
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: originals });

    for (const cookie of cookies) {
        const key = [cookie.name, cookie.domain, cookie.path, cookie.storeId].join("|");
        const originalValue = originals[key].value;
        await setCookie(cookie, "a" + originalValue);
    }

    document.getElementById("restoreBtn").disabled = false;
    setStatus(`Corrupted ${cookies.length} token(s)${envFilter ? ` for "${envFilter}"` : ""}.`);
    showCorruptedTokens(cookies);
}

document.getElementById("corruptAllBtn").addEventListener("click", () => corruptCookies(null));

function extractEnvFilter(url) {
    // Prod: events.bizzabo.com → no env filter needed, corrupt all tokens
    if (/https?:\/\/events\.bizzabo\.com/.test(url)) return { filter: null, recognized: true };
    // Dev: staging-app.bizzabo.com → extract env prefix before the dash
    const devMatch = url.match(/https?:\/\/([^.]+)-/);
    if (devMatch) return { filter: devMatch[1], recognized: true };
    return { filter: null, recognized: false };
}

document.getElementById("corruptPageBtn").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const url = tabs[0]?.url;
        if (!url) { setStatus("Could not detect current tab."); return; }
        const { filter, recognized } = extractEnvFilter(url);
        if (!recognized) { setStatus("Could not extract env from URL."); return; }
        corruptCookies(filter);
    });
});

document.getElementById("restoreBtn").addEventListener("click", async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const originals = data[STORAGE_KEY];
    if (!originals || Object.keys(originals).length === 0) {
        setStatus("No saved tokens to restore.");
        return;
    }

    let count = 0;
    for (const key of Object.keys(originals)) {
        const { cookie, value } = originals[key];
        await setCookie(cookie, value);
        count++;
    }

    await chrome.storage.local.remove(STORAGE_KEY);
    document.getElementById("restoreBtn").disabled = true;
    setStatus(`Restored ${count} token(s).`);
    showCorruptedTokens([]);
});

// On load, enable restore if there are saved originals
chrome.storage.local.get(STORAGE_KEY, data => {
    if (data[STORAGE_KEY] && Object.keys(data[STORAGE_KEY]).length > 0) {
        document.getElementById("restoreBtn").disabled = false;
    }
});
