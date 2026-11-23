# Skapi

[![Package Compatibility](https://github.com/broadwayinc/skapi-js/actions/workflows/compatibility.yml/badge.svg)](https://github.com/broadwayinc/skapi-js/actions/workflows/compatibility.yml)
[![npm version](https://img.shields.io/npm/v/skapi-js.svg)](https://www.npmjs.com/package/skapi-js)
![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-339933)
![Module](https://img.shields.io/badge/module-CJS%20%7C%20ESM-blue)
![Browser](https://img.shields.io/badge/browser-UMD%20bundle-orange)
![TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6)

**Tested environments:** Node 18/20/22, CommonJS, ESM, TypeScript consumers, Browser UMD bundle.

### Zero-Setup Serverless Backend

Skapi is a backend API that runs entirely serverless: no complex installations, no server configurations, and no database management required. Build full-featured web applications faster and focus on what matters: your product.

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

### 1. Create a Project

1. Open [skapi.com/new-project](https://www.skapi.com/new-project). If you are not signed in, it sends you to log in or sign up first and brings you back to the project form.
2. Give your project a name, an optional description and a region, and click **Continue**.
3. Choose a plan and proceed.

### 2. Initialize the Skapi library

Skapi is compatible with both vanilla HTML and webpack-based projects (ex. Vue, React, Angular... etc).
You need to import the library using the `<script>` tag or install via npm.

### For HTML projects:

For vanilla HTML projects, import Skapi in the script tag, and initialize the library.

```html
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<script>
    const skapi = new Skapi("<Project ID>");
</script>
```

**Be sure to replace `"<Project ID>"`, angle brackets included, with your actual project ID**

If you run code that still has the placeholder, Skapi asks for the Project ID (a prompt in the browser, a question in the terminal in Node.js) and uses your answer until the browser tab is closed or the Node.js process exits.

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
const skapi = new Skapi("<Project ID>");

// Export the skapi instance, so you can use it in other component files
export { skapi }
```

### Node.js (CommonJS)

To use Skapi in NodeJS, import the library as shown below:

```javascript
const { Skapi } = require('skapi-js');
const skapi = new Skapi("<Project ID>");
```

### Node.js (ESM)

```javascript
import { Skapi } from 'skapi-js';
const skapi = new Skapi("<Project ID>");
```

> **Note:** When running Skapi in Node.js, browser-specific features such as WebSocket, WebRTC, and Notifications are not available.



### 3. Test your connection

After you initialized the Skapi library, you can test your connection by pinging your request with the `mock()` method.

Below is an example of how you can use the `mock()` method in HTML forms.

```html
<!-- index.html -->
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<script>
    const skapi = new Skapi("<Project ID>");
</script>

<form onsubmit='skapi.mock(event).then(ping=>alert(ping.msg))'>
    <input name='msg' placeholder='Test message'>
    <input type='submit' value='Test Connection'>
</form>
```

This will send a request to your Skapi project and ping back the response.
When the request is resolved, the `mock()` method will return the response data as a `Promise` object.
The response data will be displayed in an alert box.


## AI-Driven Development

Skapi is ready for AI paired development through the Skapi MCP server:

```
https://mcp.skapi.com
```

Add this address as a remote MCP server (often called a custom connector) in any AI app that supports MCP, such as chat apps, coding agents in the terminal and code editors, then sign in with your Skapi account.

Once connected, your AI assistant works on your Skapi projects with your account's permissions. It can create a project, read and change records, manage users, upload your website files, and read the Skapi documentation while it writes code with this library. You ask in plain words, for example:

```
Build me a [describe what you want] with Skapi.
```

Setup steps for each app are on the [Skapi MCP page](https://mcp.skapi.com).


#### For more information, check out our [documentation](https://docs.skapi.com).

[Version History](https://docs.skapi.com/versionlog/versions.html)