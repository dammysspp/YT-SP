/**
 * MediaVault - Advanced Video & Audio Downloader
 * Frontend Application
 * 
 * UI Update Flow:
 * 1. User pastes URLs → fetchBtn click → POST /api/info
 * 2. Server returns video metadata → createVideoCard() for each
 * 3. User configures per-video settings (resolution, format, audio)
 * 4. startAllBtn click → POST /api/download with all configs
 * 5. SSE connection receives progress updates → updateCardProgress()
 * 6. Cards update status badges, progress bars, and stats in real-time
 */

// ============================================================================
// CONFIGURATION & STATE
// ============================================================================

const API_BASE = 'http://localhost:5000/api';

// Application state
const state = {
    videos: [],           // Fetched video metadata
    videoIds: new Set(),  // Track video IDs already in queue for duplicate detection
    downloads: new Map(), // Active downloads: downloadId -> cardElement
    settings: {
        downloadDir: '',
        createSubfolders: true,
        concurrentDownloads: 3
    },
    eventSource: null,    // SSE connection
    pendingVideos: null,  // Temporarily holds videos during duplicate confirmation
    duplicateResolver: null // Promise resolver for duplicate modal
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const elements = {
    // Input section
    urlInput: document.getElementById('urlInput'),
    fetchBtn: document.getElementById('fetchBtn'),
    clearUrlsBtn: document.getElementById('clearUrlsBtn'),
    dropZone: document.getElementById('dropZone'),
    dropOverlay: document.getElementById('dropOverlay'),

    // Global settings
    globalSettings: document.getElementById('globalSettings'),
    globalResolution: document.getElementById('globalResolution'),
    globalFormat: document.getElementById('globalFormat'),
    globalAudioOnly: document.getElementById('globalAudioOnly'),
    globalBitrate: document.getElementById('globalBitrate'),
    globalBitrateWrapper: document.getElementById('globalBitrateWrapper'),
    applyGlobalBtn: document.getElementById('applyGlobalBtn'),

    // Queue section
    queueSection: document.getElementById('queueSection'),
    queueCount: document.getElementById('queueCount'),
    videoCards: document.getElementById('videoCards'),
    startAllBtn: document.getElementById('startAllBtn'),
    clearQueueBtn: document.getElementById('clearQueueBtn'),

    // Loading & Toasts
    loadingOverlay: document.getElementById('loadingOverlay'),
    toastContainer: document.getElementById('toastContainer'),

    // Modals
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsModal: document.getElementById('closeSettingsModal'),
    cancelSettings: document.getElementById('cancelSettings'),
    saveSettings: document.getElementById('saveSettings'),
    downloadDir: document.getElementById('downloadDir'),
    createSubfolders: document.getElementById('createSubfolders'),

    historyBtn: document.getElementById('historyBtn'),
    historyModal: document.getElementById('historyModal'),
    closeHistoryModal: document.getElementById('closeHistoryModal'),
    closeHistoryBtn: document.getElementById('closeHistoryBtn'),
    historyList: document.getElementById('historyList'),
    clearHistory: document.getElementById('clearHistory'),

    // Duplicate modal
    duplicateModal: document.getElementById('duplicateModal'),
    duplicateMessage: document.getElementById('duplicateMessage'),
    duplicateList: document.getElementById('duplicateList'),
    closeDuplicateModal: document.getElementById('closeDuplicateModal'),
    duplicateCancel: document.getElementById('duplicateCancel'),
    duplicateSkip: document.getElementById('duplicateSkip'),
    duplicateAddAll: document.getElementById('duplicateAddAll')
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Show loading overlay
 */
function showLoading(show = true) {
    elements.loadingOverlay.style.display = show ? 'flex' : 'none';
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ'}</span>
        <span class="toast-message">${message}</span>
    `;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * Parse URLs from textarea input
 */
function parseUrls(text) {
    return text
        .split(/[\n\r]+/)
        .map(url => url.trim())
        .filter(url => url && url.match(/^https?:\/\/.+/i));
}

/**
 * Format file size
 */
function formatSize(bytes) {
    if (!bytes) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(1)} ${units[i]}`;
}

/**
 * Truncate text with ellipsis
 */
function truncate(text, maxLength = 60) {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * Generate unique ID
 */
function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Get video identifier (for duplicate detection)
 * Uses video ID if available, falls back to title
 */
function getVideoKey(video) {
    return video.id || video.title || video.url;
}

/**
 * Find duplicates in a list of videos
 * Returns { duplicates: [], unique: [] }
 */
function findDuplicates(newVideos) {
    const duplicates = [];
    const unique = [];

    for (const video of newVideos) {
        const key = getVideoKey(video);
        if (state.videoIds.has(key)) {
            duplicates.push(video);
        } else {
            unique.push(video);
        }
    }

    return { duplicates, unique };
}

/**
 * Show duplicate confirmation modal
 * Returns a Promise that resolves to 'add-all', 'skip', or 'cancel'
 */
function showDuplicateModal(duplicates) {
    return new Promise((resolve) => {
        state.duplicateResolver = resolve;

        // Update modal content
        elements.duplicateMessage.textContent =
            `${duplicates.length} video(s) are already in your queue:`;

        // Render duplicate list
        elements.duplicateList.innerHTML = duplicates.map(video => `
            <div class="duplicate-item">
                <img class="duplicate-item-thumb" 
                     src="${video.thumbnail || 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 16 9%22%3E%3Crect fill%3D%22%23333%22 width%3D%2216%22 height%3D%229%22%2F%3E%3C%2Fsvg%3E'}" 
                     alt="">
                <div class="duplicate-item-info">
                    <div class="duplicate-item-title">${truncate(video.title, 50)}</div>
                    <div class="duplicate-item-meta">${video.duration_string || '--:--'} • ${video.uploader || 'Unknown'}</div>
                </div>
            </div>
        `).join('');

        openModal(elements.duplicateModal);
    });
}

/**
 * Handle duplicate modal response
 */
function handleDuplicateChoice(choice) {
    closeModal(elements.duplicateModal);
    if (state.duplicateResolver) {
        state.duplicateResolver(choice);
        state.duplicateResolver = null;
    }
}

// ============================================================================
// VIDEO CARD COMPONENT
// ============================================================================

/**
 * Create a video card element from video info
 */
function createVideoCard(video, index) {
    const cardId = `video-${index}-${generateId()}`;

    // Default resolutions if not available
    const resolutions = video.resolutions?.length > 0
        ? video.resolutions
        : ['2160p', '1440p', '1080p', '720p', '480p', '360p', '144p'];

    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = cardId;
    card.dataset.url = video.url || video.webpage_url;
    card.dataset.index = index;

    card.innerHTML = `
        <div class="video-card-content">
            <div class="video-thumbnail">
                <img src="${video.thumbnail || 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 16 9%22%3E%3Crect fill%3D%22%23333%22 width%3D%2216%22 height%3D%229%22%2F%3E%3C%2Fsvg%3E'}" alt="${video.title}" loading="lazy">
                <span class="video-duration">${video.duration_string || '--:--'}</span>
            </div>
            <div class="video-info">
                <h3 class="video-title" title="${video.title}">${truncate(video.title, 80)}</h3>
                <div class="video-meta">
                    <span>📺 ${video.platform || 'Unknown'}</span>
                    <span>👤 ${truncate(video.uploader, 25) || 'Unknown'}</span>
                    ${video.view_count ? `<span>👁 ${video.view_count.toLocaleString()}</span>` : ''}
                </div>
                <div class="video-settings">
                    <select class="resolution-select" data-field="resolution">
                        ${resolutions.map(r => `<option value="${r}" ${r === '1080p' ? 'selected' : ''}>${r}</option>`).join('')}
                    </select>
                    <select class="format-select" data-field="format">
                        <option value="mp4" selected>MP4</option>
                        <option value="mkv">MKV</option>
                        <option value="webm">WebM</option>
                    </select>
                    <label class="audio-toggle">
                        <input type="checkbox" class="audio-only-check" data-field="audioOnly">
                        <span>🎵 Audio Only</span>
                    </label>
                    <select class="bitrate-select" data-field="audioBitrate" style="display: none;">
                        <option value="128">128 kbps</option>
                        <option value="192" selected>192 kbps</option>
                        <option value="320">320 kbps</option>
                    </select>
                    <input type="text" class="filename-input" data-field="filename" placeholder="Custom filename (optional)">
                </div>
            </div>
        </div>
        <div class="video-card-actions">
            <span class="status-badge status-queued">Queued</span>
            <div style="flex: 1;"></div>
            <button class="btn btn-sm btn-danger remove-card-btn">✕ Remove</button>
        </div>
    `;

    // Audio-only toggle handler
    const audioCheck = card.querySelector('.audio-only-check');
    const bitrateSelect = card.querySelector('.bitrate-select');
    const resolutionSelect = card.querySelector('.resolution-select');
    const formatSelect = card.querySelector('.format-select');

    audioCheck.addEventListener('change', () => {
        const isAudio = audioCheck.checked;
        bitrateSelect.style.display = isAudio ? 'block' : 'none';
        resolutionSelect.style.display = isAudio ? 'none' : 'block';
        formatSelect.style.display = isAudio ? 'none' : 'block';
    });

    // Remove card handler
    card.querySelector('.remove-card-btn').addEventListener('click', () => {
        // Remove from videoIds tracking
        const key = getVideoKey(video);
        state.videoIds.delete(key);

        card.remove();
        state.videos = state.videos.filter((_, i) => i !== index);
        updateQueueCount();
        if (state.videos.length === 0) {
            elements.queueSection.style.display = 'none';
            elements.globalSettings.style.display = 'none';
        }
    });

    return card;
}

/**
 * Update queue count display
 */
function updateQueueCount() {
    const count = elements.videoCards.children.length;
    elements.queueCount.textContent = count;
}

/**
 * Get download configuration from a card
 */
function getCardConfig(card) {
    return {
        url: card.dataset.url,
        resolution: card.querySelector('.resolution-select').value,
        format: card.querySelector('.format-select').value,
        audio_only: card.querySelector('.audio-only-check').checked,
        audio_bitrate: card.querySelector('.bitrate-select').value,
        output_filename: card.querySelector('.filename-input').value.trim(),
        download_dir: state.settings.downloadDir || '',
        create_subfolder: state.settings.createSubfolders
    };
}

/**
 * Update card status and progress
 */
function updateCardProgress(downloadId, data) {
    // Find card by download ID
    const card = state.downloads.get(downloadId);
    if (!card) return;

    const statusBadge = card.querySelector('.status-badge');
    let progressSection = card.querySelector('.progress-section');

    // Update status badge
    const statusClass = `status-${data.status}`;
    statusBadge.className = `status-badge ${statusClass}`;

    const statusLabels = {
        starting: 'Starting',
        downloading: 'Downloading',
        converting: 'Converting',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };
    statusBadge.textContent = statusLabels[data.status] || data.status;

    // Create/update progress section for downloading status
    if (data.status === 'downloading' || data.status === 'converting') {
        if (!progressSection) {
            progressSection = document.createElement('div');
            progressSection.className = 'progress-section';
            progressSection.innerHTML = `
                <div class="progress-bar-wrapper">
                    <div class="progress-bar" style="width: 0%"></div>
                </div>
                <div class="progress-stats">
                    <span class="progress-downloaded">0 MB</span>
                    <span class="progress-speed">-- MB/s</span>
                    <span class="progress-eta">ETA: --</span>
                </div>
            `;
            card.querySelector('.video-card-actions').before(progressSection);
        }

        const progressBar = progressSection.querySelector('.progress-bar');
        progressBar.style.width = `${data.percent || 0}%`;

        if (data.status === 'downloading') {
            progressSection.querySelector('.progress-downloaded').textContent =
                `${data.downloaded || '0 B'} / ${data.total || '?'}`;
            progressSection.querySelector('.progress-speed').textContent = data.speed || '-- /s';
            progressSection.querySelector('.progress-eta').textContent = `ETA: ${data.eta || '--'}`;
        } else {
            progressSection.querySelector('.progress-downloaded').textContent = 'Processing...';
            progressSection.querySelector('.progress-speed').textContent = '';
            progressSection.querySelector('.progress-eta').textContent = '';
        }
    }

    // Handle completion
    if (data.status === 'completed') {
        if (progressSection) {
            progressSection.querySelector('.progress-bar').style.width = '100%';
            progressSection.querySelector('.progress-stats').innerHTML = `
                <span>✓ Download complete: ${data.filename || 'File saved'}</span>
            `;
        }
        showToast(`Downloaded: ${truncate(data.title, 40)}`, 'success');
    }

    // Handle failure
    if (data.status === 'failed') {
        if (progressSection) {
            progressSection.querySelector('.progress-stats').innerHTML = `
                <span style="color: var(--error);">✕ Error: ${data.error || 'Download failed'}</span>
            `;
        }
        showToast(`Failed: ${truncate(data.error, 50)}`, 'error');
    }
}

// ============================================================================
// SERVER-SENT EVENTS (SSE) FOR REAL-TIME PROGRESS
// ============================================================================

/**
 * Connect to SSE endpoint for real-time progress updates
 */
function connectSSE() {
    if (state.eventSource) {
        state.eventSource.close();
    }

    state.eventSource = new EventSource(`${API_BASE}/events`);

    state.eventSource.onopen = () => {
        console.log('SSE connected');
    };

    state.eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'connected') {
                console.log('SSE client ID:', data.client_id);
                return;
            }

            // Update card progress
            if (data.download_id) {
                updateCardProgress(data.download_id, data);
            }
        } catch (e) {
            console.error('SSE parse error:', e);
        }
    };

    state.eventSource.onerror = (e) => {
        console.error('SSE error:', e);
        // Reconnect after delay
        setTimeout(connectSSE, 5000);
    };
}

// ============================================================================
// API CALLS
// ============================================================================

/**
 * Fetch video metadata from URLs
 */
async function fetchVideoInfo(urls) {
    try {
        const response = await fetch(`${API_BASE}/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Fetch error:', error);
        throw error;
    }
}

/**
 * Start downloads with configurations
 */
async function startDownloads(downloads) {
    try {
        const response = await fetch(`${API_BASE}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                downloads,
                download_dir: state.settings.downloadDir
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Download start error:', error);
        throw error;
    }
}

/**
 * Fetch download history
 */
async function fetchHistory() {
    try {
        const response = await fetch(`${API_BASE}/history`);
        if (!response.ok) throw new Error('Failed to fetch history');
        return await response.json();
    } catch (error) {
        console.error('History fetch error:', error);
        return { history: [] };
    }
}

/**
 * Clear download history
 */
async function clearHistoryAPI() {
    try {
        await fetch(`${API_BASE}/clear-history`, { method: 'POST' });
    } catch (error) {
        console.error('Clear history error:', error);
    }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle fetch videos button click
 * Supports both single videos and playlists.
 * Playlists are expanded into individual video cards.
 * Detects duplicates and prompts user for action.
 */
async function handleFetchVideos() {
    const urls = parseUrls(elements.urlInput.value);

    if (urls.length === 0) {
        showToast('Please enter at least one valid URL', 'warning');
        return;
    }

    showLoading(true);

    try {
        const result = await fetchVideoInfo(urls);

        if (!result.success || !result.videos) {
            throw new Error(result.error || 'Failed to fetch video info');
        }

        // Collect all videos from results (flatten playlists)
        let allNewVideos = [];
        let playlistCount = 0;

        result.videos.forEach((item) => {
            if (item.error) {
                showToast(`Error: ${item.error}`, 'error');
                return;
            }

            if (item.is_playlist && item.videos) {
                playlistCount++;
                showToast(`📋 Playlist detected: "${truncate(item.playlist_title, 30)}" with ${item.videos.length} videos`, 'info', 5000);

                item.videos.forEach((video) => {
                    if (video.success !== false) {
                        video._playlistInfo = {
                            title: item.playlist_title,
                            index: video.playlist_index,
                            total: item.videos.length
                        };
                        allNewVideos.push(video);
                    }
                });
            } else {
                allNewVideos.push(item);
            }
        });

        if (allNewVideos.length === 0) {
            showToast('No valid videos found', 'error');
            showLoading(false);
            return;
        }

        // Check for duplicates
        const { duplicates, unique } = findDuplicates(allNewVideos);

        let videosToAdd = [];

        if (duplicates.length > 0) {
            showLoading(false);

            // Show duplicate confirmation modal
            const choice = await showDuplicateModal(duplicates);

            if (choice === 'cancel') {
                showToast('Cancelled', 'info');
                return;
            } else if (choice === 'skip') {
                videosToAdd = unique;
                showToast(`Skipped ${duplicates.length} duplicate(s)`, 'info');
            } else {
                // add-all
                videosToAdd = allNewVideos;
            }
        } else {
            videosToAdd = allNewVideos;
        }

        if (videosToAdd.length === 0) {
            showToast('No new videos to add', 'info');
            return;
        }

        // Add videos to queue
        let videoIndex = state.videos.length;

        videosToAdd.forEach((video) => {
            // Track this video ID
            const key = getVideoKey(video);
            state.videoIds.add(key);

            state.videos.push(video);
            const card = createVideoCard(video, videoIndex);

            // Add playlist badge if from playlist
            if (video._playlistInfo) {
                const meta = card.querySelector('.video-meta');
                const playlistBadge = document.createElement('span');
                playlistBadge.className = 'playlist-badge';
                playlistBadge.innerHTML = `📋 ${video._playlistInfo.index}/${video._playlistInfo.total}`;
                playlistBadge.title = video._playlistInfo.title;
                meta.appendChild(playlistBadge);
            }

            elements.videoCards.appendChild(card);
            videoIndex++;
        });

        elements.queueSection.style.display = 'block';
        elements.globalSettings.style.display = 'block';
        updateQueueCount();

        // Success message
        const addedCount = videosToAdd.length;
        if (playlistCount > 0) {
            showToast(`Added ${addedCount} video(s) from ${playlistCount} playlist(s)`, 'success');
        } else {
            showToast(`Added ${addedCount} video(s)`, 'success');
        }

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * Handle start all downloads
 */
async function handleStartAll() {
    const cards = Array.from(elements.videoCards.querySelectorAll('.video-card'));

    if (cards.length === 0) {
        showToast('No videos in queue', 'warning');
        return;
    }

    // Connect SSE if not connected
    if (!state.eventSource || state.eventSource.readyState !== EventSource.OPEN) {
        connectSSE();
    }

    // Collect configurations from all cards
    const downloads = cards.map(card => getCardConfig(card));

    try {
        const result = await startDownloads(downloads);

        if (!result.success) {
            throw new Error(result.error || 'Failed to start downloads');
        }

        // Map download IDs to cards
        result.download_ids.forEach((id, index) => {
            if (cards[index]) {
                state.downloads.set(id, cards[index]);
                const statusBadge = cards[index].querySelector('.status-badge');
                statusBadge.className = 'status-badge status-downloading';
                statusBadge.textContent = 'Starting';
            }
        });

        showToast(`Started ${result.download_ids.length} download(s)`, 'success');

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

/**
 * Apply global settings to all cards
 */
function handleApplyGlobal() {
    const cards = elements.videoCards.querySelectorAll('.video-card');

    cards.forEach(card => {
        const resolution = elements.globalResolution.value;
        const format = elements.globalFormat.value;
        const audioOnly = elements.globalAudioOnly.checked;
        const bitrate = elements.globalBitrate.value;

        if (resolution) {
            card.querySelector('.resolution-select').value = resolution;
        }
        if (format) {
            card.querySelector('.format-select').value = format;
        }

        const audioCheck = card.querySelector('.audio-only-check');
        audioCheck.checked = audioOnly;
        audioCheck.dispatchEvent(new Event('change'));

        if (audioOnly && bitrate) {
            card.querySelector('.bitrate-select').value = bitrate;
        }
    });

    showToast('Settings applied to all videos', 'success');
}

/**
 * Clear URL input
 */
function handleClearUrls() {
    elements.urlInput.value = '';
    elements.urlInput.focus();
}

/**
 * Clear video queue
 */
function handleClearQueue() {
    elements.videoCards.innerHTML = '';
    state.videos = [];
    state.videoIds.clear();  // Clear duplicate tracking
    state.downloads.clear();
    elements.queueSection.style.display = 'none';
    elements.globalSettings.style.display = 'none';
    updateQueueCount();
}

/**
 * Render history list
 */
async function renderHistory() {
    const result = await fetchHistory();
    const history = result.history || [];

    if (history.length === 0) {
        elements.historyList.innerHTML = '<p class="history-empty">No download history yet</p>';
        return;
    }

    elements.historyList.innerHTML = history.map(item => `
        <div class="history-item">
            <div class="history-info">
                <div class="history-title">${truncate(item.title, 50)}</div>
                <div class="history-meta">
                    ${item.filename} • ${item.duration || ''} • ${item.completed_at ? new Date(item.completed_at).toLocaleString() : ''}
                </div>
            </div>
            <span class="status-badge ${item.success ? 'status-completed' : 'status-failed'}">
                ${item.success ? 'Completed' : 'Failed'}
            </span>
        </div>
    `).join('');
}

// ============================================================================
// MODAL HANDLERS
// ============================================================================

function openModal(modal) {
    modal.classList.add('active');
}

function closeModal(modal) {
    modal.classList.remove('active');
}

// ============================================================================
// DRAG AND DROP
// ============================================================================

function setupDragDrop() {
    const dropZone = elements.dropZone;
    const dropOverlay = elements.dropOverlay;

    ['dragenter', 'dragover'].forEach(event => {
        dropZone.addEventListener(event, (e) => {
            e.preventDefault();
            dropOverlay.classList.add('active');
        });
    });

    ['dragleave', 'drop'].forEach(event => {
        dropZone.addEventListener(event, (e) => {
            e.preventDefault();
            dropOverlay.classList.remove('active');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        const text = e.dataTransfer.getData('text');
        if (text) {
            elements.urlInput.value += (elements.urlInput.value ? '\n' : '') + text;
        }
    });
}

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            // Ctrl+Enter to fetch
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                handleFetchVideos();
            }
            return;
        }

        // Shortcuts
        switch (e.key.toLowerCase()) {
            case 'h':
                openModal(elements.historyModal);
                renderHistory();
                break;
            case 's':
                openModal(elements.settingsModal);
                break;
            case 'escape':
                closeModal(elements.settingsModal);
                closeModal(elements.historyModal);
                break;
        }

        // Ctrl+Shift+Enter to start all
        if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
            e.preventDefault();
            handleStartAll();
        }
    });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
    // Event listeners - Input section
    elements.fetchBtn.addEventListener('click', handleFetchVideos);
    elements.clearUrlsBtn.addEventListener('click', handleClearUrls);

    // Global settings
    elements.applyGlobalBtn.addEventListener('click', handleApplyGlobal);
    elements.globalAudioOnly.addEventListener('change', () => {
        elements.globalBitrateWrapper.style.display =
            elements.globalAudioOnly.checked ? 'block' : 'none';
    });

    // Queue controls
    elements.startAllBtn.addEventListener('click', handleStartAll);
    elements.clearQueueBtn.addEventListener('click', handleClearQueue);

    // Settings modal
    elements.settingsBtn.addEventListener('click', () => openModal(elements.settingsModal));
    elements.closeSettingsModal.addEventListener('click', () => closeModal(elements.settingsModal));
    elements.cancelSettings.addEventListener('click', () => closeModal(elements.settingsModal));
    elements.saveSettings.addEventListener('click', () => {
        state.settings.downloadDir = elements.downloadDir.value;
        state.settings.createSubfolders = elements.createSubfolders.checked;
        closeModal(elements.settingsModal);
        showToast('Settings saved', 'success');
    });

    // History modal
    elements.historyBtn.addEventListener('click', () => {
        openModal(elements.historyModal);
        renderHistory();
    });
    elements.closeHistoryModal.addEventListener('click', () => closeModal(elements.historyModal));
    elements.closeHistoryBtn.addEventListener('click', () => closeModal(elements.historyModal));
    elements.clearHistory.addEventListener('click', async () => {
        await clearHistoryAPI();
        renderHistory();
        showToast('History cleared', 'success');
    });

    // Duplicate modal
    elements.closeDuplicateModal.addEventListener('click', () => handleDuplicateChoice('cancel'));
    elements.duplicateCancel.addEventListener('click', () => handleDuplicateChoice('cancel'));
    elements.duplicateSkip.addEventListener('click', () => handleDuplicateChoice('skip'));
    elements.duplicateAddAll.addEventListener('click', () => handleDuplicateChoice('add-all'));

    // Setup features
    setupDragDrop();
    setupKeyboardShortcuts();

    // Connect SSE on load
    connectSSE();

    console.log('MediaVault initialized');
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
