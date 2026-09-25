# CUELO 中的 Git worktree

CUELO 会把同一仓库的 main checkout 和 linked worktree 放在同一个项目下。切换 worktree 会影响新会话的工作目录和文件 Explorer；已有会话仍使用创建时的目录。

## 何时显示切换器

只有选择 Git checkout 的仓库根目录时，项目选择器下方才会显示 worktree 切换器。普通目录、仓库子目录，或 Git 无法读取 worktree 列表时都无法使用。请从项目选择器打开仓库根目录。

## 切换和创建

在切换器中选择 checkout 后，Explorer 和新工作会使用该目录。重新打开已有会话时，Explorer 会切回该会话的 checkout。同一项目下的不同 worktree 会共用会话列表。

选择 **New worktree...** 并输入 branch 名称后，CUELO 会在 `<repo>-worktrees/<branch>` 下创建 checkout。branch 名称中的 `/` 会被整理，避免用作目录层级。若 branch 已存在，则连接该 branch 的 worktree；否则从当前 `HEAD` 创建新 branch。

## 移除

移除非 main 项目会删除 linked checkout，但不会删除 Git branch 或会话记录。如果 checkout 有已修改或未跟踪文件，Git 会拒绝移除，CUELO 会显示强制移除确认。强制移除可能丢弃该 checkout 中未提交的文件，请先保存需要保留的更改。

## 常见问题

- **看不到切换器：**确认当前选择的是仓库根目录，而不是仓库子目录。
- **无法添加 branch：**同一 branch 不能同时在多个 worktree 中 checkout。切换到已有 worktree，或先移除旧 checkout。
- **Explorer 和聊天似乎处于不同 branch：**Explorer 跟随当前选择的 worktree，聊天跟随已打开会话的工作目录。
- **已移除 worktree 的会话在哪里：**会话记录不会被移除；CUELO 仍可能在项目中显示这些会话。

实现依据：`lib/worktree.ts`、`app/api/worktrees/route.ts` 以及项目选择和 Explorer UI。
