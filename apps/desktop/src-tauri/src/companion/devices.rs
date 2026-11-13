//! Device management for phones with the `canManage` permission. The first
//! paired device gets it by default; the desktop can grant or revoke it for
//! any device. Every handler resolves the caller from its Bearer token, so the
//! permission check is server-side and hiding the mobile section is only UI.
//!
//! Self-management is deliberately limited: a phone can list and manage other
//! devices, but cannot change or remove itself here (the existing "unpair this
//! phone" action stays the local escape hatch).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tapd_core::config::CompanionDevice;
use tapd_i18n::tr;

use super::pairing::{bearer_token, device_for_token};
use super::{
    err_data, ok_data, presence_is_online, remove_device, set_device_manage, CompanionCtx,
};

fn unauthorized() -> Response {
    err_data(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        tr("companion.pairing.expired"),
    )
}

fn forbidden() -> Response {
    err_data(
        StatusCode::FORBIDDEN,
        "forbidden",
        tr("companion.devices.forbidden"),
    )
}

fn not_found() -> Response {
    err_data(
        StatusCode::NOT_FOUND,
        "device_not_found",
        tr("companion.devices.notfound"),
    )
}

fn self_management() -> Response {
    err_data(
        StatusCode::BAD_REQUEST,
        "device_self",
        tr("companion.devices.self"),
    )
}

/// Resolves the authenticated device and requires management permission.
fn manage_guard(ctx: &CompanionCtx, headers: &HeaderMap) -> Result<CompanionDevice, Response> {
    let Some(token) = bearer_token(headers) else {
        return Err(unauthorized());
    };
    let Some(device) = device_for_token(&ctx.state, &token) else {
        return Err(unauthorized());
    };
    if !device.can_manage {
        return Err(forbidden());
    }
    Ok(device)
}

/// `GET /companion/api/devices`: every paired device plus the caller's id.
pub(super) async fn api_devices(State(ctx): State<CompanionCtx>, headers: HeaderMap) -> Response {
    let me = match manage_guard(&ctx, &headers) {
        Ok(device) => device,
        Err(response) => return response,
    };
    let config = ctx.state.config_snapshot();
    let runtime = ctx.state.companion.lock().expect("companion lock");
    let now = chrono::Utc::now();
    let devices: Vec<_> = config
        .companion
        .devices
        .iter()
        .map(|device| {
            let presence = runtime.presence.get(&device.id);
            let online =
                presence.is_some_and(|presence| presence_is_online(presence.last_seen, now));
            json!({
                "id": device.id.clone(),
                "name": device.name.clone(),
                "pairedAt": device.paired_at.clone(),
                "online": online,
                "lastSeenAt": presence.map(|presence| presence.last_seen.to_rfc3339()),
                "canManage": device.can_manage,
                "self": device.id == me.id,
            })
        })
        .collect();

    ok_data(json!({ "selfId": me.id, "devices": devices }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionRequest {
    device_id: String,
    can_manage: bool,
}

/// `POST /companion/api/devices/permission`: toggles another device.
pub(super) async fn api_device_permission(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<PermissionRequest>,
) -> Response {
    let me = match manage_guard(&ctx, &headers) {
        Ok(device) => device,
        Err(response) => return response,
    };
    if request.device_id == me.id {
        return self_management();
    }

    let updated = match ctx.state.update_config(|config| {
        set_device_manage(
            &mut config.companion.devices,
            &request.device_id,
            request.can_manage,
        )
    }) {
        Ok(updated) => updated,
        Err(error) => {
            tracing::error!(%error, "failed to update companion device permission");
            return err_data(
                StatusCode::INTERNAL_SERVER_ERROR,
                "save_failed",
                tr("companion.devices.save"),
            );
        }
    };
    if !updated {
        return not_found();
    }
    ok_data(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnpairRequest {
    device_id: String,
}

/// `POST /companion/api/devices/unpair`: removes another device immediately.
pub(super) async fn api_device_unpair(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<UnpairRequest>,
) -> Response {
    let me = match manage_guard(&ctx, &headers) {
        Ok(device) => device,
        Err(response) => return response,
    };
    if request.device_id == me.id {
        return self_management();
    }

    let target = request.device_id.clone();
    let removed = match ctx
        .state
        .update_config(|config| remove_device(&mut config.companion.devices, &request.device_id))
    {
        Ok(removed) => removed,
        Err(error) => {
            tracing::error!(%error, "failed to remove companion device");
            return err_data(
                StatusCode::INTERNAL_SERVER_ERROR,
                "save_failed",
                tr("companion.devices.save"),
            );
        }
    };
    if !removed {
        return not_found();
    }
    ctx.state
        .companion
        .lock()
        .expect("companion lock")
        .presence
        .remove(&target);
    ok_data(json!({}))
}
