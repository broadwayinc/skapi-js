import { SkapiError } from "../Main";
import { request } from "../utils/network";

export async function subscribeNotification(params: {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}): Promise<"SUCCESS: Subscribed to receive notifications."> {
  await this.__connection;

  console.log({ params });

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
  console.log("everything went through");
  //   return response;
  return "SUCCESS: Subscribed to receive notifications.";
}

export async function vapidPublicKey() {
  await this.__connection;

  let vapid = await request.bind(this)("get-vapid-public-key", null, {
    auth: true,
  });

  console.log({ VAPIDPublicKey: vapid });
  return { VAPIDPublicKey: vapid };
}

export async function pushNotification(
  title: string,
  body: string
): Promise<"SUCESS: Notification sent."> {
  await this.__connection;

  await request.bind(this)(
    "push-notification",
    { title, body },
    {
      auth: true,
    }
  );

  return "SUCESS: Notification sent.";
}
