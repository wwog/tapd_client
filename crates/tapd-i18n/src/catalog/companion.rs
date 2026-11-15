//! Mobile companion messages. Key format: `companion.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("companion.cloudflared.install", "未检测到 cloudflared，请先安装后再建立隧道", "cloudflared not found; install it before starting a tunnel"),
    ("companion.cloudflared.missing", "未检测到 cloudflared", "cloudflared not found"),
    ("companion.cloudflared.output", "无法读取 cloudflared 输出", "Could not read cloudflared output"),
    ("companion.cloudflared.path", "cloudflared 路径无效", "Invalid cloudflared path"),
    ("companion.cloudflared.start", "无法启动 cloudflared：{}", "Could not start cloudflared: {}"),
    ("companion.disabled", "请先启用移动端伴侣", "Enable the mobile companion first"),
    ("companion.devices.forbidden", "没有设备管理权限", "No device management permission"),
    ("companion.devices.notfound", "设备不存在", "Device not found"),
    ("companion.devices.save", "设备权限保存失败", "Could not save device permission"),
    ("companion.devices.self", "不能在这里修改或解除本机", "Cannot change or unpair this device here"),
    ("companion.forbidden", "该功能未对移动端开放", "This feature is not available on mobile"),
    ("companion.files.rootReadOnly", "根目录仅支持浏览，不能编辑文件", "The filesystem root is read-only"),
    ("companion.files.writeDisabled", "桌面端未开启项目文件编辑", "Project file editing is off on the desktop"),
    ("companion.files.writeSetting", "文件编辑设置保存失败", "Could not save the file editing setting"),
    ("companion.lan.missing", "未能获取局域网地址，请检查网络连接", "Could not get the LAN address; check your network connection"),
    ("companion.notready", "伴侣服务尚未就绪", "Companion service is not ready"),
    ("companion.notrunning", "伴侣服务未运行", "Companion service is not running"),
    ("companion.pairing.device", "移动设备", "Mobile device"),
    ("companion.pairing.expired", "会话已失效，请重新配对", "Session expired; pair again"),
    ("companion.pairing.frequent", "配对请求过于频繁，请稍后再试", "Too many pairing requests; try again later"),
    ("companion.pairing.invalid", "配对码无效", "Pairing code is invalid"),
    ("companion.pairing.notloggedin", "桌面端尚未登录 TAPD", "The desktop is not signed in to TAPD"),
    ("companion.pairing.save", "配对信息保存失败", "Could not save pairing details"),
    ("companion.rate.limited", "请求过于频繁，请稍后再试", "Too many requests; try again later"),
    ("companion.tunnel.exited", "隧道进程已退出，请重新建立", "The tunnel process exited; start it again"),
    ("companion.tunnel.notready", "外网隧道尚未就绪", "Tunnel is not ready"),
    ("companion.tunnel.timeout", "建立外网隧道超时（30 秒）", "Tunnel setup timed out (30s)"),
    ("companion.user.missing", "桌面端未获取到当前用户", "The desktop has no current TAPD user"),
];
