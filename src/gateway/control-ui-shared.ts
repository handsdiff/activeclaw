import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const CONTROL_UI_AVATAR_PREFIX = "/avatar";

export function buildControlUiAvatarUrl(agentId: string): string {
  return `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}

export function resolveAssistantAvatarUrl(params: {
  avatar?: string | null;
  agentId?: string | null;
}): string | undefined {
  const avatar = params.avatar?.trim();
  if (!avatar) {
    return undefined;
  }
  if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) {
    return avatar;
  }

  if (avatar.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return avatar;
  }

  if (!params.agentId) {
    return avatar;
  }
  if (looksLikeAvatarPath(avatar)) {
    return buildControlUiAvatarUrl(params.agentId);
  }
  return avatar;
}

export { CONTROL_UI_AVATAR_PREFIX };
