# Skapi

### Zero-Setup Serverless Backend

Skapi is a backend API that runs entirely serverless—no complex installations, no server configurations, and no database management required. Build full-featured web applications faster and focus on what matters: your product.

### Works Everywhere: Vanilla HTML, SPAs, and AI Agents

No fancy frameworks or complex deployments needed. Skapi is a single JavaScript library that works seamlessly with vanilla HTML, modern frameworks like React, Vue, and Angular, and integrates effortlessly with AI-powered development tools.

### All-in-One Package

Skapi provides all the backend features you need for your web application out of the box, without the need to set up or maintain any backend servers.

- Authentication
- Database
- File Storage
- Realtime websocket messaging
- WebRTC media streaming
- Notification
- CDN
- Automated Email Systems
- API Bridge for 3rd party APIs
- File Hosting

## Getting Started

### 1. Create a service

1. Signup for an account at [skapi.com](https://www.skapi.com/signup).
2. Log in and create a new service from the `My Services` page.


### 2. Initialize the Skapi library

Skapi is compatible with both vanilla HTML and webpack-based projects (ex. Vue, React, Angular... etc).
You need to import the library using the `<script>` tag or install via npm.

### For HTML projects:

For vanilla HTML projects, import Skapi in the script tag, and initialize the library.

```html
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<script>
    const skapi = new Skapi('SERVICE_ID');
</script>
```

**Be sure to replace `'SERVICE_ID'` with the actual ID of your service**

For more information, check out our [documentation](https://docs.skapi.com/introduction/getting-started.html).

### For SPA projects:

To use Skapi in a SPA projects (such as Vue, React, or Angular), you can install skapi-js via npm.

```sh
$ npm i skapi-js
```

Then, import the library into your main JavaScript file.

```javascript
// main.js
import { Skapi } from 'skapi-js';
const skapi = new Skapi('SERVICE_ID');

// Export the skapi instance, so you can use it in other component files
export { skapi }
```

### 3. Test your connection

After you initialized the Skapi library, you can test your connection by pinging your request with the `mock()` method.

Below is an example of how you can use the `mock()` method in HTML forms.

```html
<!-- index.html -->
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<script>
    const skapi = new Skapi('SERVICE_ID');
</script>

<form onsubmit='skapi.mock(event).then(ping=>alert(ping.msg))'>
    <input name='msg' placeholder='Test message'>
    <input type='submit' value='Test Connection'>
</form>
```

This will send a request to your Skapi service and ping back the response.
When the request is resolved, the `mock()` method will return the response data as a `Promise` object.
The response data will be displayed in an alert box.


## AI-Driven Development

Skapi works seamlessly with AI-powered coding assistants.

To help your assistant understand how to integrate the Skapi API into your project, download and use the system prompt file described below.

### For Chat-Based Platforms (e.g., ChatGPT, Lovable)

#### 1. Download the system prompt file

<a href="https://docs.skapi.com/SKAPI.md" download="SKAPI.md">⬇️ SKAPI.md (Click to Download)</a>

#### 2. Go to your AI website and send a prompt

In your AI chat website or app (for example, ChatGPT at chat.openai.com or Lovable), start a new chat, attach the SKAPI.md file, and paste the following as your first LLM prompt:

```
Use the file "SKAPI.md" as a system prompt.
My Skapi service ID is: "xxxxxxxxxxxx-xxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
Build me a [describe what you want].
```

Replace the placeholder service ID with your actual service ID, and customize the last line with what you want to build.

### For AI Code Generators (e.g., Claude Code, OpenAI Codex, Gemini CLI)

#### 1. Download the system prompt file

<a href="https://docs.skapi.com/SKAPI.md" download="SKAPI.md">⬇️ SKAPI.md (Click to Download)</a>

#### 2. Rename and add it to your project

Rename the downloaded SKAPI.md file to a filename your tool recognizes, then add it to your project folder.

Examples:

- AGENT.md for OpenAI Codex
- CLAUDE.md for Anthropic Claude
- GEMINI.md for Gemini CLI

#### 3. Start writing prompts

When you invoke your code generator, include a prompt like:

```
My Skapi service ID is: "xxxxxxxxxxxx-xxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
Build me a [describe what you want].
```

Replace the placeholder service ID with your actual service ID before you run the command.


#### For more information, check out our [documentation](https://docs.skapi.com).

[Version History](https://docs.skapi.com/versionlog/versions.html)