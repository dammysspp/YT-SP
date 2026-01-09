"""
Advanced Multi-Format Video & Audio Downloader - Backend API

This is the main Flask application providing REST API endpoints for:
- URL metadata fetching (title, duration, formats, resolutions)
- Video/audio downloads with per-video custom settings
- Batch downloading with concurrent processing
- Real-time progress tracking via Server-Sent Events (SSE)

Key yt-dlp options used:
- format: Selects video+audio quality (e.g., 'bestvideo[height<=720]+bestaudio/best')
- merge_output_format: Output container format (mp4, mkv, webm)
- postprocessors: For audio extraction and conversion (FFmpegExtractAudio)
- concurrent_fragment_downloads: Parallel fragment downloading for speed
- progress_hooks: Real-time progress callbacks

Concurrency logic:
- Uses ThreadPoolExecutor for parallel batch downloads
- Each download runs in its own thread with progress reporting
- Downloads are tracked by unique IDs for status updates
- Thread-safe queue for progress events (SSE streaming)
"""

import os
import re
import sys
import json
import time
import uuid
import queue
import logging
import threading
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Any

from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS
import yt_dlp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('downloader.log', encoding='utf-8')
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='../frontend', static_url_path='')
CORS(app)

# ============================================================================
# GLOBAL STATE & CONFIGURATION
# ============================================================================

# Active downloads tracking: {download_id: download_info}
active_downloads: Dict[str, Dict] = {}

# Progress event queues for SSE: {client_id: Queue}
progress_queues: Dict[str, queue.Queue] = {}

# Download history: stores completed/failed downloads
download_history: List[Dict] = []

# Thread pool for concurrent downloads
executor = ThreadPoolExecutor(max_workers=5)

# Lock for thread-safe operations
downloads_lock = threading.Lock()

# Default download directory
DEFAULT_DOWNLOAD_DIR = str(Path.home() / "Downloads" / "VideoDownloader")

# Ensure default directory exists
os.makedirs(DEFAULT_DOWNLOAD_DIR, exist_ok=True)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def sanitize_filename(filename: str) -> str:
    """
    Sanitize filename to prevent path traversal and invalid characters.
    Removes or replaces characters that are invalid in Windows/Linux filenames.
    """
    # Remove path separators and null bytes
    filename = filename.replace('/', '_').replace('\\', '_').replace('\0', '')
    # Remove other invalid Windows characters
    invalid_chars = '<>:"|?*'
    for char in invalid_chars:
        filename = filename.replace(char, '_')
    # Limit length
    if len(filename) > 200:
        filename = filename[:200]
    # Strip leading/trailing spaces and dots
    filename = filename.strip().strip('.')
    return filename if filename else 'download'


def sanitize_url(url: str) -> str:
    """
    Basic URL sanitization to prevent command injection.
    Only allows valid URL characters.
    """
    # Remove any shell metacharacters
    dangerous_chars = [';', '&', '|', '`', '$', '(', ')', '{', '}', '[', ']', '!', '#']
    for char in dangerous_chars:
        url = url.replace(char, '')
    return url.strip()


def validate_url(url: str) -> bool:
    """
    Validate that string is a valid URL format.
    """
    url_pattern = re.compile(
        r'^https?://'  # http:// or https://
        r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,6}\.?|'  # domain
        r'localhost|'  # localhost
        r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'  # or IP
        r'(?::\d+)?'  # optional port
        r'(?:/?|[/?]\S+)$', re.IGNORECASE)
    return url_pattern.match(url) is not None


def format_size(bytes_size: Optional[int]) -> str:
    """Format bytes to human readable size string."""
    if bytes_size is None or bytes_size == 0:
        return "Unknown"
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_size < 1024:
            return f"{bytes_size:.1f} {unit}"
        bytes_size /= 1024
    return f"{bytes_size:.1f} PB"


def format_duration(seconds: Optional[int]) -> str:
    """Format seconds to HH:MM:SS string."""
    if seconds is None:
        return "Unknown"
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def broadcast_progress(download_id: str, progress_data: Dict):
    """
    Broadcast progress update to all connected SSE clients.
    Thread-safe queue push for each client.
    """
    event_data = {
        'download_id': download_id,
        **progress_data,
        'timestamp': datetime.now().isoformat()
    }
    
    # Push to all client queues
    dead_clients = []
    for client_id, q in list(progress_queues.items()):
        try:
            q.put_nowait(event_data)
        except queue.Full:
            dead_clients.append(client_id)
    
    # Clean up dead clients
    for client_id in dead_clients:
        progress_queues.pop(client_id, None)


# ============================================================================
# YT-DLP INTEGRATION
# ============================================================================

def extract_single_video_info(info: Dict, url: str) -> Dict[str, Any]:
    """
    Extract metadata from a single video info dict.
    Helper function used by both single video and playlist processing.
    """
    # Extract available formats
    formats = info.get('formats', [])
    
    # Get unique resolutions (video formats)
    resolutions = set()
    video_formats = []
    audio_formats = []
    
    for fmt in formats:
        height = fmt.get('height')
        vcodec = fmt.get('vcodec', 'none')
        acodec = fmt.get('acodec', 'none')
        
        # Video format
        if vcodec != 'none' and height:
            resolutions.add(height)
            video_formats.append({
                'format_id': fmt.get('format_id'),
                'ext': fmt.get('ext'),
                'resolution': f"{height}p",
                'height': height,
                'vcodec': vcodec,
                'filesize': fmt.get('filesize'),
                'filesize_approx': fmt.get('filesize_approx'),
                'fps': fmt.get('fps'),
                'tbr': fmt.get('tbr'),
            })
        
        # Audio format
        if acodec != 'none' and vcodec == 'none':
            audio_formats.append({
                'format_id': fmt.get('format_id'),
                'ext': fmt.get('ext'),
                'acodec': acodec,
                'abr': fmt.get('abr'),
                'filesize': fmt.get('filesize'),
                'filesize_approx': fmt.get('filesize_approx'),
            })
    
    # Sort resolutions
    sorted_resolutions = sorted(list(resolutions), reverse=True)
    resolution_options = [f"{r}p" for r in sorted_resolutions]
    
    # Detect platform
    extractor = info.get('extractor', 'unknown')
    platform = extractor.split(':')[0].title()
    
    # Get the actual video URL (webpage_url for the specific video)
    video_url = info.get('webpage_url') or info.get('url') or url
    
    return {
        'success': True,
        'url': video_url,
        'id': info.get('id'),
        'title': info.get('title', 'Unknown Title'),
        'description': (info.get('description') or '')[:500],
        'duration': info.get('duration'),
        'duration_string': format_duration(info.get('duration')),
        'thumbnail': info.get('thumbnail'),
        'uploader': info.get('uploader', 'Unknown'),
        'upload_date': info.get('upload_date'),
        'view_count': info.get('view_count'),
        'platform': platform,
        'extractor': extractor,
        'webpage_url': video_url,
        'resolutions': resolution_options if resolution_options else ['1080p', '720p', '480p', '360p'],
        'video_formats': video_formats[:20],
        'audio_formats': audio_formats[:10],
        'available_containers': ['mp4', 'mkv', 'webm'],
        'available_audio_bitrates': ['128', '192', '320'],
    }


def get_video_info(url: str) -> Dict[str, Any]:
    """
    Fetch video metadata using yt-dlp without downloading.
    Supports both single videos and playlists.
    
    For playlists: Returns a dict with is_playlist=True and a list of videos.
    For single videos: Returns a dict with the video info.
    """
    url = sanitize_url(url)
    
    # First, do a flat extraction to detect if it's a playlist
    flat_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': 'in_playlist',  # Only flatten playlists
        'skip_download': True,
    }
    
    try:
        with yt_dlp.YoutubeDL(flat_opts) as ydl:
            flat_info = ydl.extract_info(url, download=False)
            
            if flat_info is None:
                return {'error': 'Could not extract video information'}
            
            # Check if it's a playlist
            is_playlist = flat_info.get('_type') == 'playlist' or 'entries' in flat_info
            
            if is_playlist and 'entries' in flat_info:
                entries = list(flat_info.get('entries', []))
                
                if not entries:
                    return {'error': 'Playlist is empty'}
                
                playlist_title = flat_info.get('title', 'Unknown Playlist')
                playlist_uploader = flat_info.get('uploader', 'Unknown')
                
                logger.info(f"Detected playlist: {playlist_title} with {len(entries)} videos")
                
                # Detect if this is a YouTube Music playlist
                is_youtube_music = 'music.youtube.com' in url
                base_url = "https://music.youtube.com/watch?v=" if is_youtube_music else "https://www.youtube.com/watch?v="
                platform = 'Youtube Music' if is_youtube_music else 'Youtube'
                
                # FAST: Use flat extraction data directly instead of fetching each video
                # Full extraction will happen at download time
                videos = []
                for i, entry in enumerate(entries):
                    if entry is None:
                        continue
                    
                    # Construct video URL
                    video_url = entry.get('url') or entry.get('webpage_url')
                    if not video_url and entry.get('id'):
                        video_url = f"{base_url}{entry.get('id')}"
                    
                    if not video_url:
                        continue
                    
                    # Use flat extraction data - this is fast!
                    videos.append({
                        'success': True,
                        'url': video_url,
                        'id': entry.get('id'),
                        'title': entry.get('title', f'Video {i+1}'),
                        'duration': entry.get('duration'),
                        'duration_string': format_duration(entry.get('duration')),
                        'thumbnail': entry.get('thumbnail') or entry.get('thumbnails', [{}])[0].get('url') if entry.get('thumbnails') else None,
                        'uploader': entry.get('uploader') or entry.get('channel') or playlist_uploader,
                        'view_count': entry.get('view_count'),
                        'platform': platform,
                        'playlist_index': i + 1,
                        'playlist_title': playlist_title,
                        # Default resolutions - actual ones determined at download time
                        'resolutions': ['2160p', '1440p', '1080p', '720p', '480p', '360p'],
                        'available_containers': ['mp4', 'mkv', 'webm'],
                        'available_audio_bitrates': ['128', '192', '320'],
                    })
                
                logger.info(f"Playlist processed: {len(videos)} videos ready")
                
                return {
                    'success': True,
                    'is_playlist': True,
                    'playlist_title': playlist_title,
                    'playlist_uploader': playlist_uploader,
                    'playlist_url': url,
                    'video_count': len(videos),
                    'videos': videos,
                }
            
            else:
                # Single video - do full extraction
                full_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'extract_flat': False,
                    'skip_download': True,
                }
                
                with yt_dlp.YoutubeDL(full_opts) as ydl_full:
                    info = ydl_full.extract_info(url, download=False)
                    
                    if info is None:
                        return {'error': 'Could not extract video information'}
                    
                    # Handle case where single video still has entries (some extractors)
                    if 'entries' in info and info['entries']:
                        info = info['entries'][0]
                    
                    return extract_single_video_info(info, url)
            
    except yt_dlp.DownloadError as e:
        logger.error(f"yt-dlp download error for {url}: {e}")
        return {'error': f'Download error: {str(e)}'}
    except Exception as e:
        logger.error(f"Error fetching info for {url}: {e}")
        return {'error': f'Failed to fetch video info: {str(e)}'}


def create_progress_hook(download_id: str):
    """
    Create a progress hook function for yt-dlp.
    
    yt-dlp calls progress hooks with status updates during download.
    We broadcast these updates to connected SSE clients.
    """
    def progress_hook(d):
        status = d.get('status', 'unknown')
        
        if status == 'downloading':
            # Calculate progress
            downloaded = d.get('downloaded_bytes', 0)
            total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
            speed = d.get('speed', 0)
            eta = d.get('eta', 0)
            
            percent = (downloaded / total * 100) if total > 0 else 0
            
            progress_data = {
                'status': 'downloading',
                'percent': round(percent, 1),
                'downloaded': format_size(downloaded),
                'total': format_size(total),
                'speed': format_size(speed) + '/s' if speed else 'N/A',
                'eta': f"{eta}s" if eta else 'Calculating...',
                'filename': d.get('filename', ''),
            }
            
            # Update active downloads
            with downloads_lock:
                if download_id in active_downloads:
                    active_downloads[download_id].update(progress_data)
            
            broadcast_progress(download_id, progress_data)
            
        elif status == 'finished':
            progress_data = {
                'status': 'converting',
                'percent': 100,
                'message': 'Post-processing (merging/converting)...',
            }
            broadcast_progress(download_id, progress_data)
            
        elif status == 'error':
            error_msg = d.get('error', 'Unknown error')
            progress_data = {
                'status': 'failed',
                'error': str(error_msg),
            }
            broadcast_progress(download_id, progress_data)
    
    return progress_hook


def download_video(download_id: str, url: str, options: Dict) -> Dict:
    """
    Download a video with specified options.
    
    Options:
        - resolution: Target resolution (e.g., '720p', '1080p')
        - format: Output container (mp4, mkv, webm)
        - audio_only: Boolean for audio extraction
        - audio_bitrate: MP3 bitrate (128, 192, 320)
        - output_filename: Custom filename
        - download_dir: Target directory
        - create_subfolder: Create Video/Audio subfolders
    """
    url = sanitize_url(url)
    
    # Extract options with defaults
    resolution = options.get('resolution', 'best')
    container = options.get('format', 'mp4')
    audio_only = options.get('audio_only', False)
    audio_bitrate = options.get('audio_bitrate', '192')
    custom_filename = options.get('output_filename', '')
    download_dir = options.get('download_dir', DEFAULT_DOWNLOAD_DIR)
    create_subfolder = options.get('create_subfolder', True)
    
    # Sanitize filename if provided
    if custom_filename:
        custom_filename = sanitize_filename(custom_filename)
    
    # Create output directory
    if create_subfolder:
        subfolder = 'Audio' if audio_only else 'Video'
        download_dir = os.path.join(download_dir, subfolder)
    os.makedirs(download_dir, exist_ok=True)
    
    # Build output template
    if custom_filename:
        output_template = os.path.join(download_dir, f'{custom_filename}.%(ext)s')
    else:
        output_template = os.path.join(download_dir, '%(title)s.%(ext)s')
    
    # Build format string based on resolution
    if audio_only:
        format_str = 'bestaudio/best'
    else:
        # Parse resolution (e.g., '720p' -> 720)
        height = resolution.rstrip('p') if resolution != 'best' else None
        if height and height.isdigit():
            format_str = f'bestvideo[height<={height}]+bestaudio/best[height<={height}]/best'
        else:
            format_str = 'bestvideo+bestaudio/best'
    
    # yt-dlp options
    ydl_opts = {
        'format': format_str,
        'outtmpl': output_template,
        'progress_hooks': [create_progress_hook(download_id)],
        'concurrent_fragment_downloads': 5,  # Parallel fragment downloads
        'retries': 3,
        'fragment_retries': 3,
        'ignoreerrors': False,
        'no_warnings': False,
        'quiet': False,
        'noprogress': False,
        # Merge format for video downloads
        'merge_output_format': container if not audio_only else None,
        # Embed metadata
        'embedmetadata': True,
        'embedthumbnail': True,
        # FFmpeg location (use system ffmpeg)
        'ffmpeg_location': None,
    }
    
    # Audio extraction postprocessor
    if audio_only:
        ydl_opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': audio_bitrate,
        }]
    else:
        # Embed subtitles if available
        ydl_opts['writesubtitles'] = True
        ydl_opts['subtitleslangs'] = ['en']
        ydl_opts['embedsubtitles'] = True
    
    # Update download status
    with downloads_lock:
        active_downloads[download_id] = {
            'status': 'starting',
            'url': url,
            'options': options,
            'started_at': datetime.now().isoformat(),
        }
    
    broadcast_progress(download_id, {'status': 'starting', 'message': 'Initializing download...'})
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            
            if info is None:
                raise Exception("Failed to download video")
            
            # Handle playlist
            if 'entries' in info:
                info = info['entries'][0] if info['entries'] else None
            
            if info is None:
                raise Exception("No video found")
            
            # Get final filename
            filename = ydl.prepare_filename(info)
            if audio_only:
                filename = os.path.splitext(filename)[0] + '.mp3'
            else:
                filename = os.path.splitext(filename)[0] + f'.{container}'
            
            result = {
                'success': True,
                'download_id': download_id,
                'title': info.get('title', 'Unknown'),
                'filename': os.path.basename(filename),
                'filepath': filename,
                'duration': format_duration(info.get('duration')),
                'completed_at': datetime.now().isoformat(),
            }
            
            # Update status
            with downloads_lock:
                active_downloads[download_id].update({
                    'status': 'completed',
                    **result
                })
            
            broadcast_progress(download_id, {'status': 'completed', **result})
            
            # Add to history
            download_history.append(result)
            
            return result
            
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Download failed for {url}: {error_msg}")
        
        result = {
            'success': False,
            'download_id': download_id,
            'error': error_msg,
            'failed_at': datetime.now().isoformat(),
        }
        
        with downloads_lock:
            active_downloads[download_id].update({
                'status': 'failed',
                **result
            })
        
        broadcast_progress(download_id, {'status': 'failed', 'error': error_msg})
        
        return result


# ============================================================================
# API ROUTES
# ============================================================================

@app.route('/')
def serve_frontend():
    """Serve the main frontend HTML."""
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/info', methods=['POST'])
def fetch_info():
    """
    Fetch video metadata for one or more URLs.
    
    Request body:
        { "urls": ["url1", "url2", ...] }
    
    Returns:
        List of video info objects
    """
    data = request.get_json()
    
    if not data or 'urls' not in data:
        return jsonify({'error': 'No URLs provided'}), 400
    
    urls = data['urls']
    if isinstance(urls, str):
        urls = [urls]
    
    # Validate URLs
    valid_urls = []
    for url in urls:
        url = url.strip()
        if url and validate_url(url):
            valid_urls.append(url)
    
    if not valid_urls:
        return jsonify({'error': 'No valid URLs provided'}), 400
    
    # Fetch info for each URL (can be parallelized for many URLs)
    results = []
    for url in valid_urls:
        info = get_video_info(url)
        results.append(info)
    
    return jsonify({'success': True, 'videos': results})


@app.route('/api/download', methods=['POST'])
def start_download():
    """
    Start downloading one or more videos with per-video settings.
    
    Request body:
        {
            "downloads": [
                {
                    "url": "...",
                    "resolution": "720p",
                    "format": "mp4",
                    "audio_only": false,
                    "audio_bitrate": "192",
                    "output_filename": "custom_name",
                    "download_dir": "/path/to/dir",
                    "create_subfolder": true
                },
                ...
            ],
            "download_dir": "/path/to/dir"  // Global fallback
        }
    """
    data = request.get_json()
    
    if not data or 'downloads' not in data:
        return jsonify({'error': 'No downloads specified'}), 400
    
    downloads = data['downloads']
    global_dir = data.get('download_dir', DEFAULT_DOWNLOAD_DIR)
    
    download_ids = []
    
    for item in downloads:
        url = item.get('url', '').strip()
        
        if not url or not validate_url(url):
            continue
        
        # Generate unique download ID
        download_id = str(uuid.uuid4())[:8]
        download_ids.append(download_id)
        
        # Merge options
        options = {
            'resolution': item.get('resolution', 'best'),
            'format': item.get('format', 'mp4'),
            'audio_only': item.get('audio_only', False),
            'audio_bitrate': item.get('audio_bitrate', '192'),
            'output_filename': item.get('output_filename', ''),
            'download_dir': item.get('download_dir', global_dir),
            'create_subfolder': item.get('create_subfolder', True),
        }
        
        # Submit to thread pool for concurrent execution
        executor.submit(download_video, download_id, url, options)
        
        logger.info(f"Started download {download_id} for {url}")
    
    return jsonify({
        'success': True,
        'message': f'Started {len(download_ids)} download(s)',
        'download_ids': download_ids
    })


@app.route('/api/status/<download_id>')
def get_download_status(download_id: str):
    """Get status of a specific download."""
    with downloads_lock:
        if download_id in active_downloads:
            return jsonify(active_downloads[download_id])
    return jsonify({'error': 'Download not found'}), 404


@app.route('/api/status')
def get_all_status():
    """Get status of all active downloads."""
    with downloads_lock:
        return jsonify({
            'active_downloads': list(active_downloads.values()),
            'total': len(active_downloads)
        })


@app.route('/api/cancel/<download_id>', methods=['POST'])
def cancel_download(download_id: str):
    """
    Cancel a specific download.
    Note: yt-dlp doesn't support graceful cancellation easily.
    This marks it as cancelled but may not stop the actual process.
    """
    with downloads_lock:
        if download_id in active_downloads:
            active_downloads[download_id]['status'] = 'cancelled'
            broadcast_progress(download_id, {'status': 'cancelled'})
            return jsonify({'success': True, 'message': 'Download cancelled'})
    return jsonify({'error': 'Download not found'}), 404


@app.route('/api/history')
def get_history():
    """Get download history."""
    return jsonify({
        'success': True,
        'history': download_history[-50:]  # Last 50 downloads
    })


@app.route('/api/clear-history', methods=['POST'])
def clear_history():
    """Clear download history."""
    download_history.clear()
    return jsonify({'success': True, 'message': 'History cleared'})


@app.route('/api/events')
def sse_events():
    """
    Server-Sent Events endpoint for real-time progress updates.
    
    UI update flow:
    1. Frontend connects to this SSE endpoint
    2. Each download broadcasts progress to progress_queues
    3. This endpoint streams events from the queue to the client
    4. Frontend updates UI cards based on download_id
    """
    def event_stream():
        client_id = str(uuid.uuid4())
        q = queue.Queue(maxsize=100)
        progress_queues[client_id] = q
        
        try:
            # Send initial connection confirmation
            yield f"data: {json.dumps({'type': 'connected', 'client_id': client_id})}\n\n"
            
            while True:
                try:
                    # Wait for events with timeout
                    event = q.get(timeout=30)
                    yield f"data: {json.dumps(event)}\n\n"
                except queue.Empty:
                    # Send keepalive
                    yield f": keepalive\n\n"
        finally:
            progress_queues.pop(client_id, None)
    
    return Response(
        event_stream(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )


@app.route('/api/config')
def get_config():
    """Get server configuration."""
    return jsonify({
        'default_download_dir': DEFAULT_DOWNLOAD_DIR,
        'supported_formats': ['mp4', 'mkv', 'webm'],
        'supported_bitrates': ['128', '192', '320'],
        'max_concurrent': 5,
    })


# ============================================================================
# ERROR HANDLERS
# ============================================================================

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(500)
def server_error(e):
    logger.error(f"Server error: {e}")
    return jsonify({'error': 'Internal server error'}), 500


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if __name__ == '__main__':
    print("""
================================================================
     Advanced Multi-Format Video & Audio Downloader            
                     Backend Server                            
================================================================
  API Endpoints:                                              
    POST /api/info      - Fetch video metadata                
    POST /api/download  - Start downloads                     
    GET  /api/status    - Get download status                 
    GET  /api/events    - SSE progress stream                 
    GET  /api/history   - Download history                    
================================================================
    """)
    
    # Run Flask development server
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True)
