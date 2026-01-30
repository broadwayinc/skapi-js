# Skapi (NodeJS)

### Zero-Setup Serverless Backend

Skapi is a backend API that runs entirely serverless—no complex installations, no server configurations, and no database management required. Build full-featured web applications faster and focus on what matters: your product.


## Getting Started

### 1. Create a service

1. Signup for an account at [skapi.com](https://www.skapi.com/signup).
2. Log in and create a new service from the `My Services` page.


### 2. Initialize the Skapi library

To use Skapi in NodeJs, you can install skapi-node via npm.


```sh
$ npm i skapi-node
```

Then, import the library into your main JavaScript file.

```javascript
// main.js
const { Skapi } = require('skapi-node');
const skapi = new Skapi('SERVICE_ID');

// Export the skapi instance, so you can use it in other component files
export { skapi }
```

#### ES Module syntax (if your project uses ESM)

```javascript
// main.js
import { Skapi } from 'skapi-node';
const skapi = new Skapi('SERVICE_ID');

// Export the skapi instance, so you can use it in other component files
export { skapi }
```