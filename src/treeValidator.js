/**
 * 症状診断ツリー(diagnosis_trees.tree_json)の整合性検証
 *
 * チェック内容:
 *   1. root ノードが存在し choice であること
 *   2. すべての next / next_ok / next_ng / next_call / next_wait が
 *      実在するノードIDを指していること
 *   3. すべてのノードから辿った先が、必ず resolved / escalate / cancelled の
 *      いずれかの終端に到達すること(行き止まり・無限ループがないこと)
 *   4. escalate ノードには、danger_confirm の next_call からしか
 *      到達できないこと
 *
 * 戻り値: { valid: true } または { valid: false, errors: [...] }
 */

const TERMINAL_TYPES = ['resolved', 'escalate', 'cancelled'];

export function validateTree(treeJson) {
  const errors = [];

  let tree;
  try {
    tree = typeof treeJson === 'string' ? JSON.parse(treeJson) : treeJson;
  } catch (e) {
    return { valid: false, errors: [`JSONパースエラー: ${e.message}`] };
  }

  if (!tree || typeof tree !== 'object') {
    return { valid: false, errors: ['ツリーがオブジェクトではありません'] };
  }
  if (!tree.nodes || typeof tree.nodes !== 'object') {
    return { valid: false, errors: ['nodesが存在しません'] };
  }
  if (!tree.nodes.root) {
    return { valid: false, errors: ['rootノードが存在しません'] };
  }
  if (tree.nodes.root.type !== 'choice') {
    errors.push('rootノードはchoiceである必要があります');
  }

  const nodeIds = Object.keys(tree.nodes);
  const nodeIdSet = new Set(nodeIds);

  // escalateへの到達経路を記録(danger_confirmのnext_call経由のみ許可)
  const escalateReachableFrom = new Set();

  // 1. 参照整合性チェック + escalate到達経路の収集
  for (const [id, node] of Object.entries(tree.nodes)) {
    const refs = [];
    if (node.type === 'choice') {
      if (!Array.isArray(node.options) || node.options.length === 0) {
        errors.push(`${id}: choiceにoptionsがありません`);
      } else {
        for (const opt of node.options) {
          if (!opt.next) { errors.push(`${id}: optionにnextがありません(label: ${opt.label})`); continue; }
          refs.push(opt.next);
          if (opt.label && opt.label.length > 20) {
            errors.push(`${id}: label「${opt.label}」が20文字を超えています`);
          }
        }
      }
    } else if (node.type === 'fix') {
      if (node.next_ok) refs.push(node.next_ok);
      if (node.next_ng) refs.push(node.next_ng);
      if (!node.next_ok || !node.next_ng) errors.push(`${id}: fixにnext_ok/next_ngが不足しています`);
    } else if (node.type === 'danger_confirm') {
      if (node.next_call) { refs.push(node.next_call); escalateReachableFrom.add(node.next_call); }
      if (node.next_wait) refs.push(node.next_wait);
      if (!node.next_call || !node.next_wait) errors.push(`${id}: danger_confirmにnext_call/next_waitが不足しています`);
    } else if (TERMINAL_TYPES.includes(node.type)) {
      // 終端ノード、参照なし
    } else {
      errors.push(`${id}: 不明なtype「${node.type}」`);
    }

    for (const ref of refs) {
      if (!nodeIdSet.has(ref)) {
        errors.push(`${id}: 存在しないノード「${ref}」を参照しています`);
      }
    }
  }

  // 2. escalateノードは必ずdanger_confirmのnext_callからのみ到達可能かチェック
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.type === 'escalate' && !escalateReachableFrom.has(id)) {
      errors.push(`${id}: escalateはdanger_confirmのnext_call経由でのみ到達可能である必要があります`);
    }
  }

  // 3. 全ノードから終端に到達可能かチェック(深さ優先探索、ループ検出込み)
  function canReachTerminal(nodeId, visiting = new Set()) {
    if (visiting.has(nodeId)) return false; // ループ検出
    const node = tree.nodes[nodeId];
    if (!node) return false;
    if (TERMINAL_TYPES.includes(node.type)) return true;

    visiting.add(nodeId);
    let nextIds = [];
    if (node.type === 'choice') nextIds = (node.options || []).map(o => o.next).filter(Boolean);
    if (node.type === 'fix') nextIds = [node.next_ok, node.next_ng].filter(Boolean);
    if (node.type === 'danger_confirm') nextIds = [node.next_call, node.next_wait].filter(Boolean);

    // 全ての分岐が終端に到達できる必要がある(1つでも行き止まりならNG)
    const result = nextIds.length > 0 && nextIds.every(n => canReachTerminal(n, new Set(visiting)));
    return result;
  }

  for (const id of nodeIds) {
    const node = tree.nodes[id];
    if (!TERMINAL_TYPES.includes(node.type) && !canReachTerminal(id)) {
      errors.push(`${id}: 終端(resolved/escalate/cancelled)に到達できない経路があります`);
    }
  }

  // 4. resolved / cancelled が最低1つずつ存在するか
  const types = Object.values(tree.nodes).map(n => n.type);
  if (!types.includes('resolved')) errors.push('resolvedノードが1つも存在しません');
  if (!types.includes('cancelled')) errors.push('cancelledノードが1つも存在しません');

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
