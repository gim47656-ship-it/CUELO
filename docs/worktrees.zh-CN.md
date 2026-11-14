# CUELO 中的 Git worktree

CUELO 会把同一仓库的 main checkout 和 linked worktree 放在同一个项目下。切换 worktree 会影响新会话的工作目录和文件 Explorer；已有会话仍使用创建时的目录。

## 何时显示切换器

只有选择 Git checkout 的仓库根目录时，项目选择器下方才会显示 worktree 切换器。普通目录、仓库子目录，或 Git 无法读取 worktree 列表时都无法使用。请从项目选择器打开仓库根目录。

## 切换和创建

在切换器中选择 checkout 后，Explorer 和新工作会使用该目录。重新打开已有会话时，Explorer 会切回该会话的 checkout。同一项目下的不同 worktree 会共用会话列表。

选择 **New worktree...** 并输入 branch 名称后，CUELO 会在 `<repo>-worktrees/<branch>` 下创建 checkout。branch 名称中的 `/` 会被整理，避免用作目录层级。若 branch 已存在，则连接该 branch 的 worktree；否则从当前 `HEAD` 创建新 branch。

## 移除

移除非 main 项目会删除 linked checkout，但不会删除 Git branch 或会话记录。如果 checkout 有已修改或未跟踪文件，Git 会拒绝移除，CUELO 会显示强制移除确认。强制移除可能丢弃该 checkout 中未提交的文件，请先保存需要保留的更改。

如果该 checkout 中有正在进行的对话，或有会话仍留有子代理、后台任务、待投递结果或进行中的目标，CUELO 不会移除它（包括强制移除），并会提示相关会话。请在任务结束后再移除。移除进行期间，无法在该 checkout 中启动新会话。CUELO 不会检查在其外部启动的终端或编辑器等进程。

## 同一仓库中的多个会话

默认情况下，只要没有其他活跃的 CUELO 会话、Maker 或后台任务正在使用 main checkout 或其子目录，新会话就会直接留在 main checkout 中。如果 main checkout 处于繁忙状态，CUELO 会自动为新会话创建独立的 linked worktree，分支名称格式为 `wt/s-YYYYMMDD-<8位十六进制>`，路径为 `<repo>-worktrees/<转换后的分支名>`（分支名中的 `/` 会转换为 `-`）。运行在其他 linked worktree 中的会话不会使 main checkout 变为繁忙状态，CUELO 也不会统计外部未跟踪的终端或编辑器进程。如果当前已选定某个 linked worktree、处于非 Git 目录，或显式设置了 `autoWorktree: false`，则保持原有行为不变。

如果在侧边栏的可选 GitHub Issue 字段中输入了 `#123` 或与 `origin` 匹配的 GitHub Issue URL，无论 main checkout 是否繁忙，系统都会使用 `wt/issue-123` 分支准备 worktree；指向外部仓库的 URL 或无效格式会在会话启动前被拒绝。若该 Issue worktree 已存在且未被活跃占用，则会直接复用；若存在活跃冲突，则会追加后缀创建 `wt/issue-123-<8位十六进制>`。

如果常规的 `<repo>-worktrees/<转换后的分支名>` 目录已在外部被移除，但 Git 仍保留着该 Issue checkout 的注册信息，启动 Issue 会话时只会修复这一条未在使用中的缺失注册，并重新检出同一个已有分支，从而保留其中尚未集成的提交。复用已有分支时不会将其接管为自动拥有。如果因活跃使用或预留而无法修复，启动流程会改用带后缀的冲突分支。

新建自动 worktree 时，CUELO 会先 fetch `origin` 的默认分支以获取最新基线；如果获取失败，则回退到本地默认分支并在 UI 中提示回退信息。整个启动过程绝不会修改 main checkout 的状态。此外，任何未跟踪（untracked）或被忽略（ignored）的文件（包括 `node_modules` 和 `.env`）都不会被复制到新 worktree 中，请在新目录中单独安装依赖并安全地配置环境变量。

当在主仓库的子目录中请求会话且需要自动隔离时，如果新检出中存在相同的相对子目录，则会保留该路径。如果该子目录仅包含未跟踪内容而不存在于新检出中，则会打开新工作树的根目录，并显示列出缺失子目录名称的通知。满足以下条件时，自动清理会将工作树连同被忽略文件一并删除，因此仅保存在该工作树中的被忽略文件需先自行备份到别处。如果没有可用的默认分支提交（例如空仓库，或在没有本地默认分支的情况下获取失败），系统将附带原因拒绝启动，而不是共享繁忙的主工作树；无远程的非常规当前分支可作为本地默认分支的回退选项。

从 linked worktree 打开的会话与 main checkout 共享相同的项目记忆。内置核心会读取 worktree 的 `.git` 文件并定位到 main checkout 对应目录中的同一个记忆库，因此不会为每个 worktree 生成独立的记忆库；在一处记录的经验可以在另一处召回，导出到其他电脑时也会一并包含在 worktree 中编写的记忆。

日常提交在各自的 worktree 中进行，向默认分支合并发布时则使用现有的 `git_integrate` 工具（在最新主分支上变基、通过检查后快进发布，遇到冲突时暂停并由会话自行解决）；调用 `git_integrate` 不会删除当前会话所在的 worktree。推送成功后，若 main checkout 位于同一目标分支且仅处于落后状态，会对其执行 fast-forward 同步，并在无冲突时通过 3-way 合并保留未提交更改。若 main checkout 位于其他分支、处于分离头指针状态、历史已分叉或未提交更改与推送的提交冲突，则保持 main checkout 不变并在结果的 `Main checkout:` 行中说明原因。

带有 CUELO 自动创建标记的 `wt/s-*` 或 `wt/issue-*` worktree 在没有未提交更改和非忽略的未跟踪文件、且没有任何活跃占用时（`.env`、`node_modules` 等被忽略文件会一并删除），若满足以下任一条件即会被自动清理：(1) 在记录的基线之上拥有自己的提交，且当前 `HEAD` 已包含在最新 fetch 的 `origin` 默认分支中；或 (2) 没有任何自有提交及待合并内容，当前 `HEAD` 与记录的起始基线完全一致（此未改动路径无需重新 fetch 或集成，而是直接使用记录的基线引用作为单次 `git branch -d` 命令的临时上游基准）。清理会在运行时关闭（包括空闲关闭）以及调用 `GET /api/worktrees` 时触发。存在未提交更改或非忽略的未跟踪文件、仍在活跃使用、含有未合并的自有提交、无标记或用户手动创建的 worktree、main checkout 以及 `~/cuelo-run` 均不会被触碰。两条清理路径都会执行相同的移除预留、最终 `HEAD` 与状态复检，并仅使用非强制的 `git worktree remove` 和 `git branch -d`；若 Git 拒绝 `git branch -d` 删除分支，则会移除目录、保留分支并在结果与日志中报告该情况（手动移除操作依然不会删除分支）。清理后会话历史记录仍会保留：恢复已移除自动 worktree 的会话时，仅在运行时回退到 main checkout（若繁忙则新建自动 worktree），而原目录仍存在的会话则继续在原路径恢复。

从维护选项卡（全面检查提示、分段提示、行提示、HANDOFF 到期项目）启动的会话，即使没有其他会话在使用 main checkout，也始终会在新的自动 worktree（`wt/s-*`）中打开，而普通新会话仍仅在 main checkout 被占用时才使用 worktree。自动 worktree 清理除了在会话关闭和打开 worktree 列表时执行外，现在还会在服务器启动时以及每台 PC 每 2 小时一次的云同步检查时运行。移除条件保持不变，服务器启动时即将恢复的会话所属的 worktree 以及仍包含未提交修改或未合并提交的 worktree 不会被删除。此外，维护选项卡还会列出超过 3 天无人使用但仍保留未提交修改或未合并提交的自动 worktree，并显示分支、经过时间和已更改文件，以便用户决定继续处理或放弃，且不会自动删除这些 worktree。

机会性清理（opportunistic sweep）也只会清除带有 CUELO 自动创建标记的 `wt/s-*` 和 `wt/issue-*` worktree 中路径已缺失的注册信息，且无论是否已集成，都会保留本地分支和提交。这属于与上文正常干净 checkout 及分支删除不同的缺失路径注册修复：仅在完成运行时使用预留以及最终的路径缺失与活跃状态复检后，对单个目标执行不带强制选项的 `git worktree remove`，而不执行全局 prune；实际目录仍存在、悬空符号链接、已锁定的注册信息以及用户手动创建或无标记的 worktree 均不会被移除。

自动工作树清理后，恢复会话会根据繁忙规则将 `runtime cwd` 重定向到 `main` 或新的自动工作树。保存的会话标头和历史工作目录仍指向已清理的路径，且会话文件不会被移动。每次冷运行时恢复都会检查该路径并重新应用繁忙规则，而现有工作目录的恢复则保持不变。

## 常见问题

- **看不到切换器：**确认当前选择的是仓库根目录，而不是仓库子目录。
- **无法添加 branch：**同一 branch 不能同时在多个 worktree 中 checkout。切换到已有 worktree，或先移除旧 checkout。
- **Explorer 和聊天似乎处于不同 branch：**Explorer 跟随当前选择的 worktree，聊天跟随已打开会话的工作目录。
- **已移除 worktree 的会话在哪里：**会话记录不会被移除；CUELO 仍可能在项目中显示这些会话。

实现依据：`lib/worktree.ts`、`app/api/worktrees/route.ts` 以及项目选择和 Explorer UI。
