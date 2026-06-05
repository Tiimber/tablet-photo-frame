# Tablet Photo Frame Slideshow

A full-featured photo and video slideshow system with web-based management interface, Home Assistant integration, and advanced transition effects.

## Features

- **24 Transition Effects**: Including canvas-based effects like pixelate, ripple, glitch, mosaic, shatter, and paint brush
- **Web Management Interface**: Upload, organize, rename, and delete media files
- **Remote Control**: Show specific images on slideshow from any device
- **Home Assistant Integration**: Two-way sync with HA input controls
- **Video Support**: MP4, MOV, WebM with trimming capability
- **Ken Burns Effect**: Pan & zoom on images
- **Responsive Design**: Mobile-friendly with collapsible sections
- **Smart Sorting**: By name, filename, date, or type with grouping options

## Setup

### Prerequisites

- Node.js 22+
- FFmpeg (for video transcoding)
- ExifTool (for photo metadata)

### Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create configuration files:
   - `config.json` - Slideshow settings
   - `server.config.json` - Server settings (port, upload limits, polling intervals)
   - `ha_sync.json` - Home Assistant connection details (optional)

4. Start the server:
   ```bash
   npm start
   # or with PM2:
   pm2 start server.js --name slideshow
   ```

### Configuration

#### config.json
```json
{
  "interval": 10,
  "transition": "crossfade",
  "kenBurns": false,
  "order": "random",
  "fit": "cover"
}
```

#### ha_sync.json (optional)
```json
{
  "url": "http://192.168.68.140:8123",
  "token": "your_long_lived_access_token"
}
```

#### server.config.json (optional)
```json
{
  "port": 3000,
  "upload": {
    "maxSizeMB": 1024,
    "imageMagickMemoryMB": 200,
    "imageMagickMapMB": 400
  },
  "polling": {
    "photoReloadMinutes": 5,
    "showNowSeconds": 2,
    "queueInitialMs": 1200,
    "queueActiveMs": 2000,
    "queueErrorMs": 3000
  },
  "http": {
    "timeoutSeconds": 10
  },
  "paths": {
    "photos": "./photos",
    "videos": "./videos",
    "pending": "./pending",
    "thumbs": "./thumbs",
    "public": "./public"
  }
}
```

**Configuration Options:**
- `port`: Server port (can also be set via `PORT` environment variable)
- `upload.maxSizeMB`: Maximum file upload size in megabytes
- `upload.imageMagickMemoryMB`: ImageMagick memory limit for processing large images
- `upload.imageMagickMapMB`: ImageMagick map limit
- `polling.photoReloadMinutes`: How often slideshow checks for new photos
- `polling.showNowSeconds`: Polling interval for remote control commands
- `polling.queueInitialMs`: Initial delay before checking processing queue
- `polling.queueActiveMs`: Polling interval while files are processing
- `polling.queueErrorMs`: Polling interval after an error
- `http.timeoutSeconds`: HTTP timeout for external requests (e.g., Home Assistant)
- `paths.*`: Directory paths for media storage (relative to project root)

## Project Structure

```
tablet-photo-frame/
├── server.js              # Express server with media handling
├── package.json           # Node dependencies
├── config.json            # Slideshow configuration
├── server.config.json     # Server configuration (port, limits, polling)
├── ha_sync.json           # Home Assistant config
├── public/
│   ├── manage.html        # Management interface
│   └── slideshow.html     # Full-screen slideshow
├── photos/                # Uploaded images (gitignored)
├── videos/                # Uploaded videos (gitignored)
└── .gitignore
```

## API Endpoints

- `GET /` - Serve management interface
- `GET /slideshow` - Serve slideshow view
- `POST /upload` - Upload media files
- `GET /api/photos` - List all media
- `DELETE /api/photos/:name` - Delete media
- `GET /api/config` - Get slideshow config
- `POST /api/config` - Update slideshow config
- `GET /api/config/polling` - Get polling intervals (used by frontend)
- `POST /api/show-now` - Remote control: show specific image
- `GET /api/show-now` - Poll for remote control commands
- `POST /api/resume-slideshow` - Resume after show-now

## Home Assistant Integration

The system can sync with Home Assistant input controls:
- `input_number.slideshow_interval` - Slide duration in seconds
- `input_select.slideshow_transition` - Transition effect
- `input_select.slideshow_order` - Random or sequential
- `input_select.slideshow_fit` - Cover or contain
- `input_boolean.slideshow_kenburns` - Ken Burns effect toggle

## Mobile Improvements

- Collapsible upload section (saves vertical space)
- Lazy loading for images (native browser feature)
- Bigger touch targets for easier tapping (44x44pt minimum)
- Sticky toolbar for easy access while scrolling
- Responsive grid layout

## Development

To run locally:
```bash
node server.js
```

The server runs on port 3000 by default (configurable in `server.config.json` or via `PORT` environment variable).

Access:
- Management: `http://localhost:3000/`
- Slideshow: `http://localhost:3000/slideshow`

## Deployment

Recommended deployment with PM2:
```bash
pm2 start server.js --name slideshow
pm2 save
pm2 startup
```

## License

MIT
