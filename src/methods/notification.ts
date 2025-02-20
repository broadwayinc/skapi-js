import { SkapiError } from "../Main";
import { request } from "../utils/network";
import { extractFormData } from "../utils/utils";

export async function subscribeNotification(params: {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}): Promise<"SUCCESS: Subscribed to receive notifications."> {
  await this.__connection;

  if (!params.endpoint) {
    throw new SkapiError("Missing parameter: endpoint", {
      code: "INVALID_PARAMETER",
    });
  }
  if (!params.keys || !params.keys.p256dh || !params.keys.auth) {
    throw new SkapiError("Missing parameter: keys.p256dh or keys.auth", {
      code: "INVALID_PARAMETER",
    });
  }

  await request.bind(this)(
    "store-subscription",
    { endpoint: params.endpoint, keys: params.keys },
    { auth: true }
  );

  return "SUCCESS: Subscribed to receive notifications.";
}

export async function unsubscribeNotification(params: {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}): Promise<"SUCCESS: Unsubscribed from notifications."> {
  await this.__connection;

  if (!params.endpoint) {
    throw new SkapiError("Missing parameter: endpoint", {
      code: "INVALID_PARAMETER",
    });
  }
  if (!params.keys || !params.keys.p256dh || !params.keys.auth) {
    throw new SkapiError("Missing parameter: keys.p256dh or keys.auth", {
      code: "INVALID_PARAMETER",
    });
  }

  await request.bind(this)(
    "delete-subscription",
    { endpoint: params.endpoint, keys: params.keys },
    { auth: true }
  );
  return "SUCCESS: Unsubscribed from notifications.";
}


export async function vapidPublicKey() {
  await this.__connection;

  let vapid = await request.bind(this)("get-vapid-public-key", null, {
    auth: true,
  });

  return { VAPIDPublicKey: vapid };
}

export async function pushNotification(
  form: {
    title: string;
    body: string;
  },
  user_ids?: string | string[]): Promise<"SUCCESS: Notification sent."> {
  await this.__connection;

  let { title, body } = extractFormData(form || {}, { nullIfEmpty: true }).data;

  if (!title) {
    throw new SkapiError("Missing parameter: message title", {
      code: "INVALID_PARAMETER",
    });
  }
  if (!body) {
    throw new SkapiError("Missing parameter: message body", {
      code: "INVALID_PARAMETER",
    });
  }

  const payload = { title, body };

  if (user_ids) {
    if (typeof user_ids === 'string') {
      user_ids = [user_ids];
    }
    payload['user_ids'] = user_ids;
  }
  else {
    payload['user_ids'] = 'all_users';
  }

  await request.bind(this)(
    "push-notification",
    payload,
    {
      auth: true,
    }
  );

  return "SUCCESS: Notification sent.";
}
