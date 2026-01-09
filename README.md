# MediaVault - Advanced Multi-Format Video & Audio Downloader

A high-performance video/audio downloader with support for YouTube, Instagram, TikTok, Twitter/X, and 100+ platforms via yt-dlp.

![MediaVault](https://img.shields.io/badge/MediaVault-v1.0.0-brightgreen)
![Python](https://img.shields.io/badge/Python-3.8+-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

### Core Features
- **Multi-Platform Support**: YouTube, Instagram, TikTok, Twitter/X, Vimeo, Facebook, and 100+ platforms
- **Playlist Support**: Automatically detects and expands playlist URLs into individual videos
- **Multiple Formats**: MP4, MKV, WebM for video; MP3 for audio
- **Resolution Selection**: From 144p to 4K (2160p)
- **Audio Extraction**: Direct MP3 download with bitrate selection (128/192/320 kbps)
- **Batch Downloading**: Process multiple URLs simultaneously
- **Per-Video Settings**: Each video can have unique format, resolution, and audio settings

### Performance
- **Concurrent Downloads**: Multiple videos download in parallel
- **Parallel Fragments**: yt-dlp's concurrent fragment downloads for speed
- **Real-Time Progress**: Live progress bars, speed, and ETA via Server-Sent Events
- **Responsive UI**: App remains responsive during heavy downloads

### UI/UX
- **Modern Dark Theme**: Glassmorphism design with gradient effects
- **Card-Based Layout**: One card per video with individual controls
- **Status Labels**: Queued, Downloading, Converting, Completed, Failed
- **Drag & Drop**: Drop URLs directly into the app
- **Keyboard Shortcuts**: Quick access to common actions
- **Download History**: Track completed downloads

## 📋 Requirements

### System Requirements
- **Python 3.8+**
- **FFmpeg** (required for video/audio merging and conversion)
- **Modern Web Browser** (Chrome, Firefox, Edge, Safari)

### Python Dependencies
- Flask >= 3.0.0
- Flask-CORS >= 4.0.0
- yt-dlp >= 2024.1.0

## 🚀 Installation

### 1. Install FFmpeg

**Windows (using Chocolatey):**
```powershell
choco install ffmpeg
```

**Windows (manual):**
1. Download from https://ffmpeg.org/download.html
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to your PATH

**macOS:**
```bash
brew install ffmpeg
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update && sudo apt install ffmpeg
```

### 2. Clone & Setup

```bash
# Navigate to the project directory
cd yt

# Create virtual environment (recommended)
python -m venv venv

# Activate virtual environment
# Windows:
.\venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

# Install Python dependencies
pip install -r backend/requirements.txt
```

### 3. Run the Application

```bash
# Start the backend server
python backend/app.py
```

The server will start at `http://localhost:5000`

Open your browser and navigate to `http://localhost:5000` to use the app.

## 💻 Usage

### Basic Usage

1. **Paste URLs**: Enter one or more video URLs in the text area (one per line)
2. **Fetch Videos**: Click "Fetch Videos" to retrieve metadata
3. **Configure Settings**: Adjust resolution, format, or enable audio-only per video
4. **Start Downloads**: Click "Start All" to begin downloading

### Playlist Support

The app automatically detects playlist URLs and expands them:
- Paste a YouTube playlist URL (e.g., `https://www.youtube.com/playlist?list=...`)
- The app will fetch all videos from the playlist
- Each video appears as a separate card with a playlist badge showing its position
- You can configure each video individually or use "Apply to All" for batch settings

### Per-Video Settings

Each video card allows you to customize:
- **Resolution**: 144p to 4K
- **Format**: MP4, MKV, WebM
- **Audio Only**: Toggle to extract audio as MP3
- **MP3 Bitrate**: 128, 192, or 320 kbps
- **Custom Filename**: Override the default filename

### Batch Settings

Use the "Batch Settings" panel to apply settings to all videos at once:
1. Select desired resolution and format
2. Enable audio-only if needed
3. Click "Apply to All"

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Enter` | Fetch Videos |
| `Ctrl + Shift + Enter` | Start All Downloads |
| `H` | Open History |
| `S` | Open Settings |
| `Esc` | Close Modals |

## 📁 Project Structure

```
yt/
├── backend/
│   ├── app.py              # Flask backend with yt-dlp integration
│   └── requirements.txt    # Python dependencies
├── frontend/
│   ├── index.html          # Main HTML structure
│   ├── styles.css          # CSS with dark theme & animations
│   └── app.js              # Frontend JavaScript application
└── README.md               # This file
```

## 🔧 Configuration

### Download Directory
By default, downloads are saved to `~/Downloads/VideoDownloader/`.
You can change this in the Settings modal.

### Subfolder Creation
When enabled (default), the app creates:
- `Video/` subfolder for video downloads
- `Audio/` subfolder for audio-only downloads

## 🛡️ Security

- **URL Sanitization**: All URLs are sanitized to prevent command injection
- **Filename Sanitization**: Output filenames are cleaned of dangerous characters
- **Input Validation**: URLs are validated before processing

## 🐛 Troubleshooting

### "yt-dlp not found"
Make sure yt-dlp is installed:
```bash
pip install --upgrade yt-dlp
```

### "FFmpeg not found"
Ensure FFmpeg is installed and in your PATH:
```bash
ffmpeg -version
```

### "Connection refused"
Check that the backend server is running on port 5000.

### Video not downloading
1. Check if the URL is supported (try `yt-dlp URL` directly)
2. Update yt-dlp: `pip install --upgrade yt-dlp`
3. Check the console/logs for error messages

## 📝 API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/info` | Fetch video metadata |
| `POST` | `/api/download` | Start downloads |
| `GET` | `/api/status` | Get all download statuses |
| `GET` | `/api/status/<id>` | Get specific download status |
| `POST` | `/api/cancel/<id>` | Cancel a download |
| `GET` | `/api/events` | SSE stream for real-time progress |
| `GET` | `/api/history` | Get download history |
| `POST` | `/api/clear-history` | Clear download history |

## 📄 License

MIT License - feel free to use and modify as needed.

## 🙏 Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - The amazing video downloader
- [FFmpeg](https://ffmpeg.org/) - Media processing powerhouse
- [Flask](https://flask.palletsprojects.com/) - Python web framework
