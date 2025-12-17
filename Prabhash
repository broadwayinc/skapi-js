# Skapi

### Zero-Setup Backend API for HTML Frontend

Skapi is a zero-setup backend API that runs entirely serverless.
Build full-featured web applications faster with Skapi - No complex installations, No server configurations, No database management required.

### Compatible with both vanilla HTML and SPA projects

No fancy framework or complex deployment required. Just focused on the basics, Skapi is a single JavaScript library fully compatible with vanilla HTML, as well as any JS frameworks.

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
    const skapi = new Skapi('service_id', 'owner_id');
</script>
```

**Be sure to replace `'service_id'` and `'owner_id'` with the actual values of your service**

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
const skapi = new Skapi('service_id', 'owner_id');

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
    const skapi = new Skapi('service_id', 'owner_id');
</script>

<form onsubmit='skapi.mock(event).then(ping=>alert(ping.msg))'>
    <input name='msg' placeholder='Test message'>
    <input type='submit' value='Test Connection'>
</form>
```

This will send a request to your Skapi service and ping back the response.
When the request is resolved, the `mock()` method will return the response data as a `Promise` object.
The response data will be displayed in an alert box.

#### For more information, check out our [documentation](https://docs.skapi.com).


## Version History

### Current version: 1.1.10

- Fixed a bug where `updateProfile()` could become unresponsive.

**1.1.8**

- Added several utility features.

**1.1.6**

- `openidLogin()` now supports the `merge` parameter, allowing users to merge their OpenID account into an existing account.
- `inviteUser()` now supports custom invitation email templates via a provided HTML URL.
- Refactored authentication flow for efficiency.

**1.1.5**

- Fixed a bug where multiple `getRecords()` requests sometimes resolve with empty record data.

**1.1.4**

- Fixed a bug in `listPrivateRecordAccess()` parameter handling.

**1.1.3**

- Corrected type declarations for the constructor options.
- Now users can list granted users of private records via `listPrivateRecordAccess()`.

**1.1.2**

- No breaking changes in this release.
- Skapi now queues requests in batches for efficiency (Default: 30 requests per batch).
- Skapi now provides more advanced class initialization options, including event listeners for login state, user profile updates, and batch processing.
- `getNewsletters()` can now search for bounced emails and display delivery counts per email.
