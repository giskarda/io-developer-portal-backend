/**
 * Methods used to
 * - add users to Azure API management Products and Groups
 * - manage subscriptions and subscriptions keys
 *
 * See https://docs.microsoft.com/en-us/rest/api/apimanagement/
 */
import { ApiManagementClient } from "azure-arm-apimanagement";
import * as msRestAzure from "ms-rest-azure";
import { logger } from "./logger";

import {
  SubscriptionCollection,
  SubscriptionContract,
  UserContract,
  UserCreateParameters
} from "azure-arm-apimanagement/lib/models";

import * as config from "./config";

import { Either, left, right } from "fp-ts/lib/Either";
import { isNone, none, Option, some } from "fp-ts/lib/Option";
import { ulid } from "ulid";

export interface IUserData extends UserCreateParameters {
  readonly oid: string;
  readonly productName: string;
  readonly groups: ReadonlyArray<string>;
}

export interface ITokenAndCredentials {
  readonly token: msRestAzure.TokenResponse;
  readonly loginCreds: msRestAzure.MSIAppServiceTokenCredentials;
}

function getToken(
  loginCreds: msRestAzure.MSIAppServiceTokenCredentials
): Promise<msRestAzure.TokenResponse> {
  return new Promise((resolve, reject) => {
    loginCreds.getToken((err, tok) => {
      if (err) {
        logger.debug("getToken() error: %s", err.message);
        return reject(err);
      }
      resolve(tok);
    });
  });
}

export async function loginToApim(
  tokenCreds?: ITokenAndCredentials
): Promise<ITokenAndCredentials> {
  const tokenExpireTime = tokenCreds
    ? new Date(tokenCreds.token.expiresOn).getTime()
    : 0;
  const isTokenExpired = tokenExpireTime >= Date.now();

  logger.debug(
    "token %s",
    JSON.stringify(tokenCreds ? tokenCreds.token : "n/a")
  );

  logger.debug(
    "loginToApim() token expire: %s (%d) now:%d expired=%s",
    tokenCreds ? tokenCreds.token.expiresOn : "n/a",
    tokenExpireTime,
    Date.now(),
    isTokenExpired
  );

  // return old credentials in case the token is not expired
  if (tokenCreds && !isTokenExpired) {
    return tokenCreds;
  }

  const loginCreds = await msRestAzure.loginWithAppServiceMSI();
  const token = await getToken(loginCreds);

  return {
    loginCreds,
    token
  };
}

export async function getUserSubscription(
  apiClient: ApiManagementClient,
  subscriptionId: string,
  userId: string
): Promise<Option<SubscriptionContract & { readonly name: string }>> {
  logger.debug("getUserSubscription");
  const subscription = await apiClient.subscription.get(
    config.azurermResourceGroup,
    config.azurermApim,
    subscriptionId
  );
  if (subscription.userId !== userId || !subscription.name) {
    return none;
  }
  return some({ name: subscription.name, ...subscription });
}

export async function getUserSubscriptions(
  apiClient: ApiManagementClient,
  userId: string
): Promise<SubscriptionCollection> {
  logger.debug("getUserSubscriptions");
  // TODO: this list is paginated with a next-link
  // by now we get only the first result page
  return apiClient.userSubscription.list(
    config.azurermResourceGroup,
    config.azurermApim,
    userId
  );
}

export async function regeneratePrimaryKey(
  apiClient: ApiManagementClient,
  subscriptionId: string,
  userId: string
): Promise<Option<SubscriptionContract>> {
  logger.debug("regeneratePrimaryKey");
  const maybeSubscription = await getUserSubscription(
    apiClient,
    subscriptionId,
    userId
  );
  if (isNone(maybeSubscription)) {
    return none;
  }
  await apiClient.subscription.regeneratePrimaryKey(
    config.azurermResourceGroup,
    config.azurermApim,
    subscriptionId
  );
  return getUserSubscription(apiClient, subscriptionId, userId);
}

export async function regenerateSecondaryKey(
  apiClient: ApiManagementClient,
  subscriptionId: string,
  userId: string
): Promise<Option<SubscriptionContract>> {
  logger.debug("regenerateSecondaryKey");
  const maybeSubscription = await getUserSubscription(
    apiClient,
    subscriptionId,
    userId
  );
  if (isNone(maybeSubscription)) {
    return none;
  }
  await apiClient.subscription.regenerateSecondaryKey(
    config.azurermResourceGroup,
    config.azurermApim,
    subscriptionId
  );
  return getUserSubscription(apiClient, subscriptionId, userId);
}

/**
 * Return the corresponding API management user
 * given the Active Directory B2C user's email.
 */
export async function getApimUser(
  apiClient: ApiManagementClient,
  email: string
): Promise<
  Option<UserContract & { readonly id: string; readonly name: string }>
> {
  logger.debug("getApimUser");
  const results = await apiClient.user.listByService(
    config.azurermResourceGroup,
    config.azurermApim,
    { filter: "email eq '" + email + "'" }
  );
  logger.debug("apimUsers found", results);
  if (!results || results.length === 0) {
    return none;
  }
  const user = results[0];
  if (!user.id || !user.name) {
    return none;
  }
  // return first matching user
  return some({ id: user.id, name: user.name, ...user });
}

export async function addUserSubscriptionToProduct(
  apiClient: ApiManagementClient,
  userId: string,
  productName: string
): Promise<Either<Error, SubscriptionContract>> {
  logger.debug("addUserToProduct");
  const product = await apiClient.product.get(
    config.azurermResourceGroup,
    config.azurermApim,
    productName
  );
  if (!product || !product.id) {
    return left(new Error("Cannot find API management product for update"));
  }
  const subscriptionId = ulid();
  // For some odd reason in the Azure ARM API
  // user.name here is actually the user.id.
  // We do not skip existing subscriptions
  // so we can activate a canceled one.
  return right(
    await apiClient.subscription.createOrUpdate(
      config.azurermResourceGroup,
      config.azurermApim,
      subscriptionId,
      {
        displayName: subscriptionId,
        productId: product.id,
        state: "active",
        userId
      }
    )
  );
}

/**
 * Returns the array of added groups names (as strings).
 */
export async function addUserToGroups(
  apiClient: ApiManagementClient,
  user: UserContract,
  groups: ReadonlyArray<string>
): Promise<Either<Error, ReadonlyArray<string>>> {
  logger.debug("addUserToGroups");
  if (!user || !user.name) {
    return left(new Error("Cannot parse user"));
  }
  const existingGroups = await apiClient.userGroup.list(
    config.azurermResourceGroup,
    config.azurermApim,
    user.name
  );
  const existingGroupsNames = new Set(existingGroups.map(g => g.name));
  logger.debug("addUserToGroups|groups|%s", existingGroupsNames);
  const missingGroups = new Set(
    groups.filter(g => !existingGroupsNames.has(g))
  );
  if (missingGroups.size === 0) {
    logger.debug(
      "addUserToGroups|user already belongs to groups|%s",
      existingGroupsNames
    );
    return right([]);
  }
  // sequence the promises here as calling this method
  // concurrently seems to cause some issues assigning
  // users to groups
  return right(
    await groups.reduce(async (prev, group) => {
      const addedGroups = await prev;
      // For some odd reason in the Azure ARM API user.name
      // here is actually the user.id
      await apiClient.groupUser.create(
        config.azurermResourceGroup,
        config.azurermApim,
        group,
        user.name as string
      );
      return [...addedGroups, group];
    }, Promise.resolve([]))
  );
}