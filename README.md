
# Skapi

#### current version: 0.1.100
<br>

Welcome to Skapi, the serverless backend API service that simplifies your web development.

This guide will walk you through importing the Skapi library into your project, creating a service, and connecting your application to the Skapi server.


## Creating a service

1. Register for an account at [skapi.com](https://www.skapi.com/signup).
2. Log in and create a new service from your [admin page](https://www.skapi.com/admin).

## Initializing the Skapi library

Skapi is compatible with both vanilla HTML and webpack-based projects (ex. Vue, React, Angular... etc).
You need to import the library using the `<script>` tag or install via npm.

### For HTML projects

For vanilla HTML projects, you can import Skapi using the script tag.

Add the following script to the head tag of your HTML file:

```html
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
```

This is what your starter code should look like:
```html
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<body>
  <!-- Your content goes here -->
</body>
<script>
    // Initialize Skapi
    // Replace 'service_id' and 'owner_id' with the values from your Skapi dashboard.
    const skapi = new Skapi('service_id', 'owner_id');
    ...
</script>
```


### For webpack projects

To use Skapi in a webpack-based project (such as Vue, React, or Angular), install skapi-js using npm:

```sh
$ npm install skapi-js
```

Then, import the library into your main JavaScript file:

```javascript
// main.js
import { Skapi } from 'skapi-js'; // imports the library

// Initialize Skapi
// Replace 'service_id' and 'owner_id' with the values from your Skapi dashboard.
const skapi = new Skapi('service_id', 'owner_id');

// export the initialized Skapi instance.
export { skapi }

// Now you can import Skapi from anywhere in your project.
```

Don't forget to replace `service_id` and `owner_id` with the values provided in your Skapi dashboard.

## Obtaining Connection Information

After initializing the Skapi object, you can retrieve information about the current connection by calling the `getConnection()` method. This method returns a `promise` that resolves with an object containing the following properties:

```typescript
{
  email: string; // The email address of the service owner.
  ip: string; // The IP address of the current connection.
  locale: string; // The current locale of the connection.
  owner: string; // The user ID of the service owner.
  region: string; // The region where the service resource is located.
  service: string; // The service ID.
  timestamp: number; // The timestamp of the service creation.
}
```

Here's an example of how to use `getConnection()`:

```javascript
skapi.getConnection().then((c) => {
    // Connection information
    console.log(c);
  });
```