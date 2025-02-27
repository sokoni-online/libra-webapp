// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {AnyAction} from 'redux';
import {batchActions} from 'redux-batched-actions';

import {Client4} from 'mattermost-redux/client';

import {ActionFunc, ActionResult, DispatchFunc, GetStateFunc} from 'mattermost-redux/types/actions';
import {UserProfile, UserStatus, GetFilteredUsersStatsOpts, UsersStats, UserCustomStatus} from '@mattermost/types/users';
import {UserTypes, AdminTypes, GeneralTypes, PreferenceTypes, TeamTypes, RoleTypes} from 'mattermost-redux/action_types';

import {setServerVersion, getClientConfig, getLicenseConfig} from 'mattermost-redux/actions/general';
import {getMyTeams, getMyTeamMembers, getMyTeamUnreads} from 'mattermost-redux/actions/teams';
import {loadRolesIfNeeded} from 'mattermost-redux/actions/roles';
import {bindClientFunc, forceLogoutIfNecessary, debounce} from 'mattermost-redux/actions/helpers';
import {logError} from 'mattermost-redux/actions/errors';
import {getMyPreferences} from 'mattermost-redux/actions/preferences';
import {
    convertRolesNamesArrayToString,
    myDataQuery,
    MyDataQueryResponseType,
    transformToRecievedMeReducerPayload,
    transformToRecievedTeamsListReducerPayload,
    transformToRecievedMyTeamMembersReducerPayload,
    transformToRecievedRolesReducerPayload,
} from 'mattermost-redux/actions/users_queries';

import {getServerVersion} from 'mattermost-redux/selectors/entities/general';
import {getCurrentUserId, getUsers} from 'mattermost-redux/selectors/entities/users';
import {isCollapsedThreadsEnabled, isGraphQLEnabled} from 'mattermost-redux/selectors/entities/preferences';

import {removeUserFromList} from 'mattermost-redux/utils/user_utils';
import {isMinimumServerVersion} from 'mattermost-redux/utils/helpers';
import {General} from 'mattermost-redux/constants';

export function checkMfa(loginId: string): ActionFunc {
    return async (dispatch: DispatchFunc) => {
        dispatch({type: UserTypes.CHECK_MFA_REQUEST, data: null});
        try {
            const data = await Client4.checkUserMfa(loginId);
            dispatch({type: UserTypes.CHECK_MFA_SUCCESS, data: null});
            return {data: data.mfa_required};
        } catch (error) {
            dispatch({type: UserTypes.CHECK_MFA_FAILURE, error});
            dispatch(logError(error));
            return {error};
        }
    };
}

export function generateMfaSecret(userId: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.generateMfaSecret,
        params: [
            userId,
        ],
    });
}

export function createUser(user: UserProfile, token: string, inviteId: string, redirect: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let created;

        try {
            created = await Client4.createUser(user, token, inviteId, redirect);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const profiles: {
            [userId: string]: UserProfile;
        } = {
            [created.id]: created,
        };
        dispatch({type: UserTypes.RECEIVED_PROFILES, data: profiles});

        return {data: created};
    };
}

export function login(loginId: string, password: string, mfaToken = '', ldapOnly = false): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        dispatch({type: UserTypes.LOGIN_REQUEST, data: null});

        const state = getState();

        try {
            await Client4.login(loginId, password, mfaToken, ldapOnly);

            let isSuccessfullyLoggedIn = false;
            if (isGraphQLEnabled(state)) {
                const dataFromLoad = await dispatch(loadMe());
                isSuccessfullyLoggedIn = dataFromLoad && dataFromLoad.data;
            } else {
                const dataFromLoadMeREST = await dispatch(loadMeREST());
                isSuccessfullyLoggedIn = dataFromLoadMeREST && dataFromLoadMeREST.data;
            }

            if (isSuccessfullyLoggedIn) {
                dispatch({type: UserTypes.LOGIN_SUCCESS});
            }
        } catch (error) {
            dispatch({
                type: UserTypes.LOGIN_FAILURE,
                error,
            });
            dispatch(logError(error));
            return {error};
        }

        return {data: true};
    };
}

export function loginById(id: string, password: string, mfaToken = ''): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        dispatch({type: UserTypes.LOGIN_REQUEST, data: null});

        const state = getState();

        try {
            await Client4.loginById(id, password, mfaToken);

            let isSuccessfullyLoggedIn = false;
            if (isGraphQLEnabled(state)) {
                const dataFromLoadMe = await dispatch(loadMe());
                isSuccessfullyLoggedIn = dataFromLoadMe && dataFromLoadMe.data;
            } else {
                const dataFromLoadMeREST = await dispatch(loadMeREST());
                isSuccessfullyLoggedIn = dataFromLoadMeREST && dataFromLoadMeREST.data;
            }

            if (isSuccessfullyLoggedIn) {
                dispatch({type: UserTypes.LOGIN_SUCCESS});
            }
        } catch (error) {
            dispatch({
                type: UserTypes.LOGIN_FAILURE,
                error,
            });
            dispatch(logError(error));
            return {error};
        }

        return {data: true};
    };
}

export function loadMeREST(): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const state = getState();

        // Sometimes the server version is set in one or the other
        const serverVersion = state.entities.general.serverVersion || Client4.getServerVersion();
        dispatch(setServerVersion(serverVersion));

        try {
            await Promise.all([
                dispatch(getClientConfig()),
                dispatch(getLicenseConfig()),
                dispatch(getMe()),
                dispatch(getMyPreferences()),
                dispatch(getMyTeams()),
                dispatch(getMyTeamMembers()),
            ]);

            const isCollapsedThreads = isCollapsedThreadsEnabled(state);
            await dispatch(getMyTeamUnreads(isCollapsedThreads));
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        const {currentUserId} = state.entities.users;
        if (currentUserId) {
            Client4.setUserId(currentUserId);
        }

        const user = state.entities.users.profiles[currentUserId];
        if (user) {
            Client4.setUserRoles(user.roles);
        }

        return {data: true};
    };
}

export function loadMe(): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const state = getState();

        // Sometimes the server version is set in one or the other
        const serverVersion = state.entities.general.serverVersion || Client4.getServerVersion();
        dispatch(setServerVersion(serverVersion));

        let responseData: MyDataQueryResponseType['data'] | null = null;
        try {
            const {data} = await Client4.fetchWithGraphQL<MyDataQueryResponseType>(myDataQuery);
            responseData = data;
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        if (!responseData) {
            return {data: false};
        }

        dispatch(
            batchActions([
                {
                    type: GeneralTypes.CLIENT_LICENSE_RECEIVED,
                    data: responseData.license,
                },
                {
                    type: GeneralTypes.CLIENT_CONFIG_RECEIVED,
                    data: responseData.config,
                },
                {
                    type: UserTypes.RECEIVED_ME,
                    data: transformToRecievedMeReducerPayload(responseData.user),
                },
                {
                    type: RoleTypes.RECEIVED_ROLES,
                    data: transformToRecievedRolesReducerPayload(responseData.user.roles, responseData.teamMembers),
                },
                {
                    type: PreferenceTypes.RECEIVED_ALL_PREFERENCES,
                    data: responseData.user.preferences,
                },
                {
                    type: TeamTypes.RECEIVED_TEAMS_LIST,
                    data: transformToRecievedTeamsListReducerPayload(responseData.teamMembers),
                },
                {
                    type: TeamTypes.RECEIVED_MY_TEAM_MEMBERS,
                    data: transformToRecievedMyTeamMembersReducerPayload(responseData.teamMembers, responseData.user.id),
                },
            ]),
        );

        if (responseData.user.id) {
            Client4.setUserId(responseData.user.id);
            Client4.setUserRoles(convertRolesNamesArrayToString(responseData.user.roles));
        }

        return {data: true};
    };
}

export function logout(): ActionFunc {
    return async (dispatch: DispatchFunc) => {
        dispatch({type: UserTypes.LOGOUT_REQUEST, data: null});

        try {
            await Client4.logout();
        } catch (error) {
            // nothing to do here
        }

        dispatch({type: UserTypes.LOGOUT_SUCCESS, data: null});

        return {data: true};
    };
}

export function getTotalUsersStats(): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getTotalUsersStats,
        onSuccess: UserTypes.RECEIVED_USER_STATS,
    });
}

export function getFilteredUsersStats(options: GetFilteredUsersStatsOpts = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let stats: UsersStats;
        try {
            stats = await Client4.getFilteredUsersStats(options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_FILTERED_USER_STATS,
            data: stats,
        });

        return {data: stats};
    };
}

export function getProfiles(page = 0, perPage: number = General.PROFILE_CHUNK_SIZE, options: any = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles: UserProfile[];

        try {
            profiles = await Client4.getProfiles(page, perPage, options);
            removeUserFromList(currentUserId, profiles);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_PROFILES_LIST,
            data: profiles,
        });

        return {data: profiles};
    };
}

export function getMissingProfilesByIds(userIds: string[]): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {profiles} = getState().entities.users;
        const missingIds: string[] = [];
        userIds.forEach((id) => {
            if (!profiles[id]) {
                missingIds.push(id);
            }
        });

        if (missingIds.length > 0) {
            getStatusesByIds(missingIds)(dispatch, getState);
            return getProfilesByIds(missingIds)(dispatch, getState);
        }

        return {data: []};
    };
}

export function getMissingProfilesByUsernames(usernames: string[]): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {profiles} = getState().entities.users;

        const usernameProfiles = Object.values(profiles).reduce((acc, profile: any) => {
            acc[profile.username] = profile;
            return acc;
        }, {} as Record<string, UserProfile>);
        const missingUsernames: string[] = [];
        usernames.forEach((username) => {
            if (!usernameProfiles[username]) {
                missingUsernames.push(username);
            }
        });

        if (missingUsernames.length > 0) {
            return getProfilesByUsernames(missingUsernames)(dispatch, getState);
        }

        return {data: []};
    };
}

export function getProfilesByIds(userIds: string[], options?: any): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles: UserProfile[];

        try {
            profiles = await Client4.getProfilesByIds(userIds, options);
            removeUserFromList(currentUserId, profiles);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_PROFILES_LIST,
            data: profiles,
        });

        return {data: profiles};
    };
}

export function getProfilesByUsernames(usernames: string[]): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesByUsernames(usernames);
            removeUserFromList(currentUserId, profiles);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_PROFILES_LIST,
            data: profiles,
        });

        return {data: profiles};
    };
}

export function getProfilesInTeam(teamId: string, page: number, perPage: number = General.PROFILE_CHUNK_SIZE, sort = '', options: any = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesInTeam(teamId, page, perPage, sort, options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_TEAM,
                data: profiles,
                id: teamId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: removeUserFromList(currentUserId, [...profiles]),
            },
        ]));

        return {data: profiles};
    };
}

export function getProfilesNotInTeam(teamId: string, groupConstrained: boolean, page: number, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let profiles;
        try {
            profiles = await Client4.getProfilesNotInTeam(teamId, groupConstrained, page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const receivedProfilesListActionType = groupConstrained ? UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_TEAM_AND_REPLACE : UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_TEAM;

        dispatch(batchActions([
            {
                type: receivedProfilesListActionType,
                data: profiles,
                id: teamId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: profiles,
            },
        ]));

        return {data: profiles};
    };
}

export function getProfilesWithoutTeam(page: number, perPage: number = General.PROFILE_CHUNK_SIZE, options: any = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let profiles = null;
        try {
            profiles = await Client4.getProfilesWithoutTeam(page, perPage, options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {
                type: UserTypes.RECEIVED_PROFILES_LIST_WITHOUT_TEAM,
                data: profiles,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: profiles,
            },
        ]));

        return {data: profiles};
    };
}

export enum ProfilesInChannelSortBy {
    None = '',
    Admin = 'admin',
}

export function getProfilesInChannel(channelId: string, page: number, perPage: number = General.PROFILE_CHUNK_SIZE, sort = '', options: {active?: boolean} = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesInChannel(channelId, page, perPage, sort, options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_CHANNEL,
                data: profiles,
                id: channelId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: removeUserFromList(currentUserId, [...profiles]),
            },
        ]));

        return {data: profiles};
    };
}

export function getProfilesInGroupChannels(channelsIds: string[]): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let channelProfiles;

        try {
            channelProfiles = await Client4.getProfilesInGroupChannels(channelsIds.slice(0, General.MAX_GROUP_CHANNELS_FOR_PROFILES));
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const actions: AnyAction[] = [];
        for (const channelId in channelProfiles) {
            if (channelProfiles.hasOwnProperty(channelId)) {
                const profiles = channelProfiles[channelId];

                actions.push(
                    {
                        type: UserTypes.RECEIVED_PROFILES_LIST_IN_CHANNEL,
                        data: profiles,
                        id: channelId,
                    },
                    {
                        type: UserTypes.RECEIVED_PROFILES_LIST,
                        data: removeUserFromList(currentUserId, [...profiles]),
                    },
                );
            }
        }

        dispatch(batchActions(actions));

        return {data: channelProfiles};
    };
}

export function getProfilesNotInChannel(teamId: string, channelId: string, groupConstrained: boolean, page: number, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesNotInChannel(teamId, channelId, groupConstrained, page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const receivedProfilesListActionType = groupConstrained ? UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_CHANNEL_AND_REPLACE : UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_CHANNEL;

        dispatch(batchActions([
            {
                type: receivedProfilesListActionType,
                data: profiles,
                id: channelId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: removeUserFromList(currentUserId, [...profiles]),
            },
        ]));

        return {data: profiles};
    };
}

export function getMe(): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const getMeFunc = bindClientFunc({
            clientFunc: Client4.getMe,
            onSuccess: UserTypes.RECEIVED_ME,
        });
        const me = await getMeFunc(dispatch, getState);

        if ('error' in me) {
            return me;
        }
        if ('data' in me) {
            dispatch(loadRolesIfNeeded(me.data.roles.split(' ')));
        }
        return me;
    };
}

export function updateMyTermsOfServiceStatus(termsOfServiceId: string, accepted: boolean): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const response: ActionResult = await dispatch(bindClientFunc({
            clientFunc: Client4.updateMyTermsOfServiceStatus,
            params: [
                termsOfServiceId,
                accepted,
            ],
        }));

        if ('data' in response) {
            if (accepted) {
                dispatch({
                    type: UserTypes.RECEIVED_TERMS_OF_SERVICE_STATUS,
                    data: {
                        terms_of_service_create_at: new Date().getTime(),
                        terms_of_service_id: accepted ? termsOfServiceId : null,
                        user_id: getCurrentUserId(getState()),
                    },
                });
            }

            return {
                data: response.data,
            };
        }

        return {
            error: response.error,
        };
    };
}

export function getProfilesInGroup(groupId: string, page = 0, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesInGroup(groupId, page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_GROUP,
                data: profiles,
                id: groupId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: removeUserFromList(currentUserId, [...profiles]),
            },
        ]));

        return {data: profiles};
    };
}

export function getProfilesNotInGroup(groupId: string, page = 0, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;
        let profiles;

        try {
            profiles = await Client4.getProfilesNotInGroup(groupId, page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {
                type: UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_GROUP,
                data: profiles,
                id: groupId,
            },
            {
                type: UserTypes.RECEIVED_PROFILES_LIST,
                data: removeUserFromList(currentUserId, [...profiles]),
            },
        ]));

        return {data: profiles};
    };
}

export function getTermsOfService(): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getTermsOfService,
    });
}

export function promoteGuestToUser(userId: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.promoteGuestToUser,
        params: [userId],
    });
}

export function demoteUserToGuest(userId: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.demoteUserToGuest,
        params: [userId],
    });
}

export function createTermsOfService(text: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.createTermsOfService,
        params: [
            text,
        ],
    });
}

export function getUser(id: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getUser,
        onSuccess: UserTypes.RECEIVED_PROFILE,
        params: [
            id,
        ],
    });
}

export function getUserByUsername(username: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getUserByUsername,
        onSuccess: UserTypes.RECEIVED_PROFILE,
        params: [
            username,
        ],
    });
}

export function getUserByEmail(email: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getUserByEmail,
        onSuccess: UserTypes.RECEIVED_PROFILE,
        params: [
            email,
        ],
    });
}

// We create an array to hold the id's that we want to get a status for. We build our
// debounced function that will get called after a set period of idle time in which
// the array of id's will be passed to the getStatusesByIds with a cb that clears out
// the array. Helps with performance because instead of making 75 different calls for
// statuses, we are only making one call for 75 ids.
// We could maybe clean it up somewhat by storing the array of ids in redux state possbily?
let ids: string[] = [];
const debouncedGetStatusesByIds = debounce(async (dispatch: DispatchFunc, getState: GetStateFunc) => {
    getStatusesByIds([...new Set(ids)])(dispatch, getState);
}, 20, false, () => {
    ids = [];
});
export function getStatusesByIdsBatchedDebounced(id: string) {
    ids = [...ids, id];
    return debouncedGetStatusesByIds;
}

export function getStatusesByIds(userIds: string[]): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getStatusesByIds,
        onSuccess: UserTypes.RECEIVED_STATUSES,
        params: [
            userIds,
        ],
    });
}

export function getStatus(userId: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getStatus,
        onSuccess: UserTypes.RECEIVED_STATUS,
        params: [
            userId,
        ],
    });
}

export function setStatus(status: UserStatus): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.updateStatus(status);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_STATUS,
            data: status,
        });

        return {data: status};
    };
}

export function setCustomStatus(customStatus: UserCustomStatus): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.updateCustomStatus,
        params: [
            customStatus,
        ],
    });
}

export function unsetCustomStatus(): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.unsetCustomStatus,
    });
}

export function removeRecentCustomStatus(customStatus: UserCustomStatus): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.removeRecentCustomStatus,
        params: [
            customStatus,
        ],
    });
}

export function getSessions(userId: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getSessions,
        onSuccess: UserTypes.RECEIVED_SESSIONS,
        params: [
            userId,
        ],
    });
}

export function revokeSession(userId: string, sessionId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.revokeSession(userId, sessionId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.RECEIVED_REVOKED_SESSION,
            sessionId,
            data: null,
        });

        return {data: true};
    };
}

export function revokeAllSessionsForUser(userId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.revokeAllSessionsForUser(userId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }
        const data = {isCurrentUser: userId === getCurrentUserId(getState())};
        dispatch(batchActions([
            {
                type: UserTypes.REVOKE_ALL_USER_SESSIONS_SUCCESS,
                data,
            },
        ]));

        return {data: true};
    };
}

export function revokeSessionsForAllUsers(): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.revokeSessionsForAllUsers();
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }
        dispatch({
            type: UserTypes.REVOKE_SESSIONS_FOR_ALL_USERS_SUCCESS,
            data: null,
        });
        return {data: true};
    };
}

export function getUserAudits(userId: string, page = 0, perPage: number = General.AUDITS_CHUNK_SIZE): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getUserAudits,
        onSuccess: UserTypes.RECEIVED_AUDITS,
        params: [
            userId,
            page,
            perPage,
        ],
    });
}

export function autocompleteUsers(term: string, teamId = '', channelId = '', options?: {
    limit: number;
}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        dispatch({type: UserTypes.AUTOCOMPLETE_USERS_REQUEST, data: null});

        const {currentUserId} = getState().entities.users;

        let data;
        try {
            data = await Client4.autocompleteUsers(term, teamId, channelId, options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch({type: UserTypes.AUTOCOMPLETE_USERS_FAILURE, error});
            dispatch(logError(error));
            return {error};
        }

        let users = [...data.users];
        if (data.out_of_channel) {
            users = [...users, ...data.out_of_channel];
        }
        removeUserFromList(currentUserId, users);
        const actions: AnyAction[] = [{
            type: UserTypes.RECEIVED_PROFILES_LIST,
            data: users,
        }, {
            type: UserTypes.AUTOCOMPLETE_USERS_SUCCESS,
        }];

        if (channelId) {
            actions.push(
                {
                    type: UserTypes.RECEIVED_PROFILES_LIST_IN_CHANNEL,
                    data: data.users,
                    id: channelId,
                },
            );
            actions.push(
                {
                    type: UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_CHANNEL,
                    data: data.out_of_channel || [],
                    id: channelId,
                },
            );
        }

        if (teamId) {
            actions.push(
                {
                    type: UserTypes.RECEIVED_PROFILES_LIST_IN_TEAM,
                    data: users,
                    id: teamId,
                },
            );
        }

        dispatch(batchActions(actions));

        return {data};
    };
}

export function searchProfiles(term: string, options: any = {}): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const {currentUserId} = getState().entities.users;

        let profiles;
        try {
            profiles = await Client4.searchUsers(term, options);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const actions: AnyAction[] = [{type: UserTypes.RECEIVED_PROFILES_LIST, data: removeUserFromList(currentUserId, [...profiles])}];

        if (options.in_channel_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_CHANNEL,
                data: profiles,
                id: options.in_channel_id,
            });
        }

        if (options.not_in_channel_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_CHANNEL,
                data: profiles,
                id: options.not_in_channel_id,
            });
        }

        if (options.team_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_TEAM,
                data: profiles,
                id: options.team_id,
            });
        }

        if (options.not_in_team_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_TEAM,
                data: profiles,
                id: options.not_in_team_id,
            });
        }

        if (options.in_group_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_IN_GROUP,
                data: profiles,
                id: options.in_group_id,
            });
        }

        if (options.not_in_group_id) {
            actions.push({
                type: UserTypes.RECEIVED_PROFILES_LIST_NOT_IN_GROUP,
                data: profiles,
                id: options.not_in_group_id,
            });
        }

        dispatch(batchActions(actions));

        return {data: profiles};
    };
}

let statusIntervalId: NodeJS.Timeout|null;
export function startPeriodicStatusUpdates(): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        if (statusIntervalId) {
            clearInterval(statusIntervalId);
        }

        statusIntervalId = setInterval(
            () => {
                const {statuses} = getState().entities.users;

                if (!statuses) {
                    return;
                }

                const userIds = Object.keys(statuses);
                if (!userIds.length) {
                    return;
                }

                getStatusesByIds(userIds)(dispatch, getState);
            },
            General.STATUS_INTERVAL,
        );

        return {data: true};
    };
}

export function stopPeriodicStatusUpdates(): ActionFunc {
    return async () => {
        if (statusIntervalId) {
            clearInterval(statusIntervalId);
        }

        return {data: true};
    };
}

export function updateMe(user: UserProfile): ActionFunc {
    return async (dispatch: DispatchFunc) => {
        dispatch({type: UserTypes.UPDATE_ME_REQUEST, data: null});

        let data;
        try {
            data = await Client4.patchMe(user);
        } catch (error) {
            dispatch({type: UserTypes.UPDATE_ME_FAILURE, error});
            dispatch(logError(error));
            return {error};
        }

        dispatch(batchActions([
            {type: UserTypes.RECEIVED_ME, data},
            {type: UserTypes.UPDATE_ME_SUCCESS},
        ]));
        dispatch(loadRolesIfNeeded(data.roles.split(' ')));

        return {data};
    };
}

export function patchUser(user: UserProfile): ActionFunc {
    return async (dispatch: DispatchFunc) => {
        let data: UserProfile;
        try {
            data = await Client4.patchUser(user);
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        dispatch({type: UserTypes.RECEIVED_PROFILE, data});

        return {data};
    };
}

export function updateUserRoles(userId: string, roles: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.updateUserRoles(userId, roles);
        } catch (error) {
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, roles}});
        }

        return {data: true};
    };
}

export function updateUserMfa(userId: string, activate: boolean, code = ''): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.updateUserMfa(userId, activate, code);
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, mfa_active: activate}});
        }

        return {data: true};
    };
}

export function updateUserPassword(userId: string, currentPassword: string, newPassword: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.updateUserPassword(userId, currentPassword, newPassword);
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, last_password_update_at: new Date().getTime()}});
        }

        return {data: true};
    };
}

export function updateUserActive(userId: string, active: boolean): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.updateUserActive(userId, active);
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            const deleteAt = active ? 0 : new Date().getTime();
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, delete_at: deleteAt}});
        }

        return {data: true};
    };
}

export function verifyUserEmail(token: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.verifyUserEmail,
        params: [
            token,
        ],
    });
}

export function sendVerificationEmail(email: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.sendVerificationEmail,
        params: [
            email,
        ],
    });
}

export function resetUserPassword(token: string, newPassword: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.resetUserPassword,
        params: [
            token,
            newPassword,
        ],
    });
}

export function sendPasswordResetEmail(email: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.sendPasswordResetEmail,
        params: [
            email,
        ],
    });
}

export function setDefaultProfileImage(userId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.setDefaultProfileImage(userId);
        } catch (error) {
            dispatch(logError(error));
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, last_picture_update: 0}});
        }

        return {data: true};
    };
}

export function uploadProfileImage(userId: string, imageData: any): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.uploadProfileImage(userId, imageData);
        } catch (error) {
            return {error};
        }

        const profile = getState().entities.users.profiles[userId];
        if (profile) {
            dispatch({type: UserTypes.RECEIVED_PROFILE, data: {...profile, last_picture_update: new Date().getTime()}});
        }

        return {data: true};
    };
}

export function switchEmailToOAuth(service: string, email: string, password: string, mfaCode = ''): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.switchEmailToOAuth,
        params: [
            service,
            email,
            password,
            mfaCode,
        ],
    });
}

export function switchOAuthToEmail(currentService: string, email: string, password: string): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.switchOAuthToEmail,
        params: [
            currentService,
            email,
            password,
        ],
    });
}

export function switchEmailToLdap(email: string, emailPassword: string, ldapId: string, ldapPassword: string, mfaCode = ''): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.switchEmailToLdap,
        params: [
            email,
            emailPassword,
            ldapId,
            ldapPassword,
            mfaCode,
        ],
    });
}

export function switchLdapToEmail(ldapPassword: string, email: string, emailPassword: string, mfaCode = ''): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.switchLdapToEmail,
        params: [
            ldapPassword,
            email,
            emailPassword,
            mfaCode,
        ],
    });
}

export function createUserAccessToken(userId: string, description: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let data;

        try {
            data = await Client4.createUserAccessToken(userId, description);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const actions: AnyAction[] = [{
            type: AdminTypes.RECEIVED_USER_ACCESS_TOKEN,
            data: {...data,
                token: '',
            },
        }];

        const {currentUserId} = getState().entities.users;
        if (userId === currentUserId) {
            actions.push(
                {
                    type: UserTypes.RECEIVED_MY_USER_ACCESS_TOKEN,
                    data: {...data, token: ''},
                },
            );
        }

        dispatch(batchActions(actions));

        return {data};
    };
}

export function getUserAccessToken(tokenId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let data;
        try {
            data = await Client4.getUserAccessToken(tokenId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const actions: AnyAction[] = [{
            type: AdminTypes.RECEIVED_USER_ACCESS_TOKEN,
            data,
        }];

        const {currentUserId} = getState().entities.users;
        if (data.user_id === currentUserId) {
            actions.push(
                {
                    type: UserTypes.RECEIVED_MY_USER_ACCESS_TOKEN,
                    data,
                },
            );
        }

        dispatch(batchActions(actions));

        return {data};
    };
}

export function getUserAccessTokens(page = 0, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let data;

        try {
            data = await Client4.getUserAccessTokens(page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: AdminTypes.RECEIVED_USER_ACCESS_TOKENS,
            data,
        });

        return {data};
    };
}

export function getUserAccessTokensForUser(userId: string, page = 0, perPage: number = General.PROFILE_CHUNK_SIZE): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        let data;
        try {
            data = await Client4.getUserAccessTokensForUser(userId, page, perPage);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const actions: AnyAction[] = [{
            type: AdminTypes.RECEIVED_USER_ACCESS_TOKENS_FOR_USER,
            data,
            userId,
        }];

        const {currentUserId} = getState().entities.users;
        if (userId === currentUserId) {
            actions.push(
                {
                    type: UserTypes.RECEIVED_MY_USER_ACCESS_TOKENS,
                    data,
                },
            );
        }

        dispatch(batchActions(actions));

        return {data};
    };
}

export function revokeUserAccessToken(tokenId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.revokeUserAccessToken(tokenId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.REVOKED_USER_ACCESS_TOKEN,
            data: tokenId,
        });

        return {data: true};
    };
}

export function disableUserAccessToken(tokenId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.disableUserAccessToken(tokenId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.DISABLED_USER_ACCESS_TOKEN,
            data: tokenId,
        });

        return {data: true};
    };
}

export function enableUserAccessToken(tokenId: string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        try {
            await Client4.enableUserAccessToken(tokenId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: UserTypes.ENABLED_USER_ACCESS_TOKEN,
            data: tokenId,
        });

        return {data: true};
    };
}

export function getKnownUsers(): ActionFunc {
    return bindClientFunc({
        clientFunc: Client4.getKnownUsers,
    });
}

export function clearUserAccessTokens(): ActionFunc {
    return async (dispatch) => {
        dispatch({type: UserTypes.CLEAR_MY_USER_ACCESS_TOKENS, data: null});
        return {data: true};
    };
}

export function checkForModifiedUsers() {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const state = getState();
        const users = getUsers(state);
        const lastDisconnectAt = state.websocket.lastDisconnectAt;
        const serverVersion = getServerVersion(state);

        if (!isMinimumServerVersion(serverVersion, 5, 14)) {
            return {data: true};
        }

        await dispatch(getProfilesByIds(Object.keys(users), {since: lastDisconnectAt}));
        return {data: true};
    };
}

export default {
    checkMfa,
    generateMfaSecret,
    login,
    logout,
    getProfiles,
    getProfilesByIds,
    getProfilesInTeam,
    getProfilesInChannel,
    getProfilesNotInChannel,
    getUser,
    getMe,
    getUserByUsername,
    getStatus,
    getStatusesByIds,
    getSessions,
    getTotalUsersStats,
    revokeSession,
    revokeAllSessionsForUser,
    revokeSessionsForAllUsers,
    getUserAudits,
    searchProfiles,
    startPeriodicStatusUpdates,
    stopPeriodicStatusUpdates,
    updateMe,
    updateUserRoles,
    updateUserMfa,
    updateUserPassword,
    updateUserActive,
    verifyUserEmail,
    sendVerificationEmail,
    resetUserPassword,
    sendPasswordResetEmail,
    uploadProfileImage,
    switchEmailToOAuth,
    switchOAuthToEmail,
    switchEmailToLdap,
    switchLdapToEmail,
    getTermsOfService,
    createTermsOfService,
    updateMyTermsOfServiceStatus,
    createUserAccessToken,
    getUserAccessToken,
    getUserAccessTokensForUser,
    revokeUserAccessToken,
    disableUserAccessToken,
    enableUserAccessToken,
    checkForModifiedUsers,
};
