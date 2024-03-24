# Skapi

Skapi is a backend API Library for HTML Frontend.
Now you can build fullstack web applications directly from your HTML frontend without the need for a backend server deployment.

### Compatible with both vanilla HTML and SPA projects

No fancy framework or complex deployment required. Just focused on the basics, Skapi is a single JavaScript library fully compatible with vanilla HTML, as well as any frontend frameworks.

### All-in-One Package

Skapi provides all the backend features you need for your web application out of the box, without the need to set up or maintain any backend servers.

- Authentication
- Database
- File Storage
- CDN
- Automated Email Systems
- Realtime Messaging
- API Bridge for 3rd party API's
- Hosting


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

export { skapi }

// Now you can import skapi from anywhere in your project.
```

### 3. Test your connection

After you initialized the Skapi library, you can test your connection by pinging your request with the `mock()` method.

Below is an example of how you can use the `mock()` method in both HTML forms and JavaScript code.

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