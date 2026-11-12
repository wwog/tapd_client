//! Regression test against a captured TAPD `changes_list` response.

use tapd_core::tapd::parse_changes_html;

const HTML: &str = include_str!("fixtures/changes_list.html");

#[test]
fn parses_real_tapd_change_history() {
    let history = parse_changes_html(HTML).expect("history");

    assert_eq!(history.total, 5);
    assert_eq!(history.changes.len(), 5);

    let newest = &history.changes[0];
    assert_eq!(newest.seq, 1);
    assert_eq!(newest.time, "2026-11-09 17:03:16");
    assert_eq!(newest.author, "张三");
    assert_eq!(newest.kind, "手动变更");
    assert_eq!(newest.fields.len(), 1);
    assert_eq!(newest.fields[0].field, "处理人");
    assert_eq!(newest.fields[0].before, "赵六;");
    assert_eq!(newest.fields[0].after, "张三");

    let status_change = &history.changes[1];
    assert_eq!(status_change.fields.len(), 5);
    let status = status_change
        .fields
        .iter()
        .find(|field| field.field == "状态")
        .expect("状态 field");
    assert_eq!(status.before, "接受/处理");
    assert_eq!(status.after, "已解决");

    // 序号 descends, and every change carries at least one field row.
    assert_eq!(
        history.changes.iter().map(|change| change.seq).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5]
    );
    assert!(history.changes.iter().all(|change| !change.fields.is_empty()));
}
