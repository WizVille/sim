import { getEnv, isTruthy } from '@/lib/core/config/env'

export async function getHeliconeVertexHeaders(request) {
  const accessToken = await getAccessToken()

  let headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Helicone-Auth': `Bearer ${getEnv('NEXT_PUBLIC_HELICONE_SA')}`,
    'Helicone-Target-URL': getEnv('NEXT_PUBLIC_GOOGLE_BASE_URL'),
    'Helicone-User-Id': 'sandbox',
    'User-Agent': 'node-fetch'
  };

  const heliconeHeaders = Object.values(request?.workflowVariables || {}).reduce((acc, variable) => {
    if (variable.name.startsWith('helicone')) {
      acc[variable.name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-')] = variable.value
      return acc;
    }
  }, {})

  headers = { ...headers, ...heliconeHeaders }

  const conversationId = findValueByKey(request.blockData, "conversationId")
  if (conversationId) {
    headers = { ...headers, ...{
      "Helicone-Session-Id": conversationId,
      "Helicone-Session-Path": "/chat",
      "Helicone-Session-Name": `${headers['Helicone-User-Id'] || 'sandbox'}`
    } }
  }

  return headers
}


export async function getHeliconeAzureHeaders(request) {
  const accessToken = await getAccessToken()

  let headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Helicone-Auth': `Bearer ${getEnv('NEXT_PUBLIC_HELICONE_SA')}`,
    'Helicone-Target-URL': getEnv('NEXT_PUBLIC_GOOGLE_BASE_URL'),
    'Helicone-User-Id': 'sandbox',
    'User-Agent': 'node-fetch'
  };

  const heliconeHeaders = Object.values(request?.workflowVariables || {}).reduce((acc, variable) => {
    if (variable.name.startsWith('helicone')) {
      acc[variable.name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-')] = variable.value
      return acc;
    }
  }, {})

  headers = { ...headers, ...heliconeHeaders }

  const conversationId = findValueByKey(request.blockData, "conversationId")
  if (conversationId) {
    headers = { ...headers, ...{
      "Helicone-Session-Id": conversationId,
      "Helicone-Session-Path": "/chat",
      "Helicone-Session-Name": `${headers['Helicone-User-Id'] || 'sandbox'}`
    } }
  }

  return headers
}

const getAccessToken = async (): Promise<string> => {
  const endpoint = getEnv('NEXT_PUBLIC_APP_URL').replace("ai.", "app.").replace("3003", "3000")
  const response = await fetch(
    `${endpoint}/api/ilovellm/google_access_token?hsa=${getEnv('NEXT_PUBLIC_HELICONE_SA')}`,
    {
      headers: {
        'Content-Type': 'application/json',
      }
    }
  );
  const body = await response.json()
  return body.token
}

function findValueByKey(obj, keyToFind) {
  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }

  if (keyToFind in obj) {
    return obj[keyToFind];
  }

  for (const value of Object.values(obj)) {
    const result = findValueByKey(value, keyToFind);

    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}
