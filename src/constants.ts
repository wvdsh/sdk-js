// ========== LOBBIES ==========
export const LOBBY_TYPE = {
	PUBLIC: 0,
	FRIENDS_ONLY: 1,
	PRIVATE: 2
} as const;

// ========== LEADERBOARDS ==========
export const LEADERBOARD_SORT_ORDER = {
	ASC: 0,
	DESC: 1
} as const;

export const LEADERBOARD_DISPLAY_TYPE = {
	NUMERIC: 0,
	TIME_SECONDS: 1,
	TIME_MILLISECONDS: 2
} as const;

// ========== USER GENERATED CONTENT ==========
export const UGC_CONTENT_TYPE = {
	SCREENSHOT: 0,
	VIDEO: 1,
	COMMUNITY: 2,
	GAME_MANAGED: 3, // Managed completely by the game, user doesn't edit
	OTHER: 4
} as const;

export const UGC_VISIBILITY = {
	PUBLIC: 0,
	FRIENDS_ONLY: 1,
	PRIVATE: 2
} as const;