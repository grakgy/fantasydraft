# 球员位置手动维护

`player-position-maintenance.csv`是球员位置的人工维护入口。它包含全部外场球员以及八维参考值，可用Excel打开、筛选和批量修改。

只修改以下三列：

- `最佳位置`
- `第二位置`
- `其他可用位置`

同一档有多个位置时使用中文顿号`、`分隔。允许的位置只有：门将以外的13个外场位置，即左后卫、左翼卫、中后卫、右后卫、右翼卫、后腰、中前卫、前腰、左边前卫、右边前卫、左边锋、右边锋、中锋。

`定价位置（只读）`必须继续保留在最佳位置中；修改定价位置还会影响能力和价格模型，不能通过这个轻量同步脚本直接修改。ID和姓名也不要修改。

在项目根目录运行：

```powershell
node scripts/player-position-maintenance.mjs --apply
node scripts/player-position-maintenance.mjs --check
```

`--apply`会同步两份外场CSV和前后端两份JSON；`--check`只校验，不写文件。底库新增球员后先运行`--refresh`，已有人工位置会保留，新球员会自动追加。
