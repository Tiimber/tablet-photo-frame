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

## Project Structure

```
tablet-photo-frame/
├── server.js           # Express server with media handling
├── package.json        # Node dependencies
├── config.json         # Slideshow configuration
├── ha_sync.json        # Home Assistant config
├── public/
│   ├── manage.html     # Management interface
│   └── slideshow.html  # Full-screen slideshow
├── photos/             # Uploaded images (gitignored)
├── videos/             # Uploaded videos (gitignored)
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

The server runs on port 3000 by default. Access:
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
