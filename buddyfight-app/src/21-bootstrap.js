// ==========================================================================
// buddyfight モジュール 21 — イベント登録・起動・テストAPI公開
// 旧 app.js L10908-11102 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
if (globalThis.__BUDDYFIGHT_THIN__) {
  // シンクライアント（play.html）: ローカル解決もローカルゲーム起動も行わない。
  // サーバ配信viewを描画するフックだけ公開する（操作の配線は play.js 側）。
  globalThis.__buddyfightThin = {
    applyView: (view) => {
      state = view;
      if (state) {
        state.selected = state.selected ?? null;
        state.linkAttackers = state.linkAttackers ?? [];
      }
      render();
    },
    render,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    elements,
    loadGameData, // デッキ一覧のクライアント側フォールバック用
    getDeckProfiles: () => deckProfiles,
    setViewerSeat: (seat) => {
      thinViewerSeat = Number.isInteger(seat) ? seat : null;
    },
  };
} else {
document.querySelectorAll(".zone.field").forEach((zoneButton) => {
  zoneButton.addEventListener("click", (event) => {
    if (suppressNextZoneClick) {
      suppressNextZoneClick = false;
      return; // ロングプレス直後のclickは無視
    }
    const owner = Number(zoneButton.dataset.owner);
    const zone = zoneButton.dataset.zone;
    // 対象選択モード中（権威版仕様）: 候補タップ＝確定 / 相手の装備枠タップ＝本体攻撃 /
    // 自分のカードタップ＝選択し直し / それ以外の候補外タップは無視（キャンセルはバナーのボタン）。
    if (uiTargeting?.mode === "attack") {
      if (isAttackCandidateZone(owner, zone)) {
        confirmAttackTarget(zone);
        return;
      }
      if (
        zone === "item" &&
        uiTargeting.candidates.some((candidate) => candidate.value === "fighter" && candidate.owner === owner)
      ) {
        confirmAttackTarget("fighter");
        return;
      }
      const resolvedAtkZone = resolveClickedItemZone(event, owner, zone);
      if (owner === state.active && state.players[owner]?.field?.[resolvedAtkZone]) {
        uiTargeting = null;
        fieldCardMenuLocal(owner, resolvedAtkZone);
      }
      return;
    }
    if (uiTargeting?.mode === "effect") {
      // 複数アイテム時はタップしたアイテムの実スロット(item2..)を解決してから候補判定/確定する（攻撃/平時分岐と同じ）。
      const resolvedEffZone = resolveClickedItemZone(event, owner, zone);
      if (isEffectCandidateZone(owner, resolvedEffZone)) {
        pickEffectTarget(owner, resolvedEffZone);
      }
      return; // 候補外タップは無視（権威版と同じ。キャンセルはバナーのボタン）
    }
    // 平時：操作可能なカードは下部アクションメニュー、相手/操作不可のカードは閲覧専用シート。
    // 空きマスのタップは無反応（権威版と同じ）。複数アイテム時はタップしたアイテムの実スロットを対象にする。
    const resolvedZone = resolveClickedItemZone(event, owner, zone);
    const card = state.players[owner]?.field?.[resolvedZone];
    if (card && !fieldCardMenuLocal(owner, resolvedZone)) {
      openReadOnlyCardSheet(card);
    }
  });
  attachZoneLongPress(zoneButton);
});

document.querySelectorAll(".drop-zone").forEach((zoneButton) => {
  zoneButton.addEventListener("click", () => {
    showDropDialog(Number(zoneButton.dataset.owner));
  });
});

// 配置魔法パイル: タップで一覧ダイアログ（自分の配置魔法は選択/使用、相手のは裏向き閲覧）。
document.querySelectorAll(".set-pile").forEach((pile) => {
  pile.addEventListener("click", () => {
    showSetSpellDialog(Number(pile.dataset.owner));
  });
});

// 対象選択バナーの「キャンセル」: targeting を解除して再描画。
document.querySelector("#targetingCancelButton")?.addEventListener("click", () => {
  uiTargeting = null;
  clearTargetingBanner();
  render();
});

document.querySelectorAll("[data-call-zone]").forEach((button) => {
  button.addEventListener("click", async () => {
    // 権威版仕様: 確認なしで即コール（メニューのコール項目と同じ）。
    await runNetworkMutation("コール", () => callMonster(button.dataset.callZone));
  });
});

// B2: ワールドタイル → デッキ情報ポップアップ
document.querySelectorAll(".buddy-cell").forEach((tile) => {
  tile.addEventListener("click", (event) => {
    // fighter-panel へのバブリングで本体攻撃と二重発火しないように遮断（権威版 play.js と同じガード）。
    event.stopPropagation();
    if (uiTargeting) {
      return; // 対象選択中はデッキ情報を開かない
    }
    const owner = Number(tile.dataset.owner);
    if (Number.isInteger(owner)) {
      openDeckInfo(owner);
    }
  });
});

// B2: 相手本体（ファイター）への攻撃対象タップ
document.querySelectorAll(".fighter-panel[data-fighter-owner]").forEach((panel) => {
  panel.addEventListener("click", () => {
    if (uiTargeting?.mode !== "attack") {
      return;
    }
    const owner = Number(panel.dataset.fighterOwner);
    if (uiTargeting.candidates.some((candidate) => candidate.value === "fighter" && candidate.owner === owner)) {
      confirmAttackTarget("fighter");
    }
  });
});

elements.newGameButton.addEventListener("click", () => runNetworkMutation("新規ゲーム", newGame));
elements.exportLogButton?.addEventListener("click", downloadBattleLog);
elements.rulesButton.addEventListener("click", () => elements.rulesDialog.showModal());
elements.closeRulesButton.addEventListener("click", () => elements.rulesDialog.close());
elements.closeDropDialogButton?.addEventListener("click", () => elements.dropDialog?.close());
elements.dropDialog?.addEventListener("close", hideCardTooltip);
elements.drawButton.addEventListener("click", () => runNetworkMutation("ドロー", drawAction));
elements.chargeButton.addEventListener("click", () => runNetworkMutation("チャージ&ドロー", chargeAction));
elements.mainPhaseButton.addEventListener("click", () => runNetworkMutation("メインフェイズ", goMainPhase));
elements.castButton.addEventListener("click", () => runNetworkMutation("カード使用", useCardAction));
elements.resolveAttackButton.addEventListener("click", () => runNetworkMutation("解決", resolvePendingResolution));
elements.counterHandButton.addEventListener("click", toggleCounterHand);
elements.attackPhaseButton.addEventListener("click", () => runNetworkMutation("アタックフェイズ", goAttackPhase));
elements.linkToggleButton.addEventListener("click", toggleLinkAttacker);
elements.finalPhaseButton.addEventListener("click", () => runNetworkMutation("ファイナルフェイズ", goFinalPhase));
elements.attackButton.addEventListener("click", () => {
  // B2: 対象未指定なら対象選択モードへ。値があれば従来どおり宣言。
  if (!elements.attackTarget.value) {
    startAttackTargeting();
    return;
  }
  runNetworkMutation("攻撃宣言", attackAction);
});
elements.endTurnButton.addEventListener("click", () => {
  // 権威版仕様: 確認なしで即ターン終了。
  runNetworkMutation("ターン終了", endTurn);
});
elements.partnerCallButton.addEventListener("click", partnerCall);
elements.attackTarget.addEventListener("change", renderActions);
elements.effectTarget.addEventListener("change", renderActions);
elements.p1DeckSelect.addEventListener("change", () => syncNetworkDeckChoice(0));
elements.p2DeckSelect.addEventListener("change", () => syncNetworkDeckChoice(1));
elements.createRoomButton?.addEventListener("click", createNetworkRoom);
elements.joinRoomButton?.addEventListener("click", joinNetworkRoom);
elements.copyRoomButton?.addEventListener("click", copyRoomId);

// B2: カードシート / デッキ情報 / 確認ダイアログの配線
elements.closeCardSheetButton?.addEventListener("click", closeCardSheet);
elements.cardSheet?.addEventListener("close", () => {
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  suppressNextZoneClick = false;
  hideCardTooltip();
});
// 背景（バックドロップ）クリックでカードシートを閉じる
elements.cardSheet?.addEventListener("click", (event) => {
  if (event.target === elements.cardSheet) {
    closeCardSheet();
  }
});
elements.closeDeckInfoButton?.addEventListener("click", () => elements.deckInfoDialog?.close());
// 背景タップで dropDialog(ドロップ/配置魔法一覧)・deckInfoDialog を閉じる（cardSheet と挙動統一）。
[elements.dropDialog, elements.deckInfoDialog].forEach((dlg) => {
  dlg?.addEventListener("click", (event) => {
    if (event.target === dlg) dlg.close();
  });
});
// カード・盤面ゾーン上ではOSのコンテキストメニューを抑止（スマホ長押し＝カード確認に割り当て済み。
// Android はCSSの touch-callout/user-select だけでは画像長押しメニューが開くため JS でも止める）。
// ログ等のテキストは対象外（closest で .card / ゾーンボタンに限定）。
if (typeof document.addEventListener === "function") {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest(".card") || target.closest("[data-zone]"))) {
      event.preventDefault();
    }
  });
}
// ☰メニュー: 外側タップ、またはメニュー項目クリックで閉じる＋aria-expanded同期（トグル自体はHTMLのonclickに任せる）。
// document.addEventListener はブラウザのみ（テスト/エンジンのDOMスタブには無いので存在チェック）。
if (typeof document.addEventListener === "function") {
  document.addEventListener("click", (event) => {
    if (!document.body.classList.contains("nav-open")) return;
    if (event.target.closest(".nav-toggle")) return;
    const item = event.target.closest(".toolbar a, .toolbar button");
    const outside = !event.target.closest(".toolbar");
    if (outside || (item && !item.closest(".log-toggle, .theme-toggle"))) {
      document.body.classList.remove("nav-open");
      document.querySelector(".nav-toggle")?.setAttribute("aria-expanded", "false");
    }
  });
}
// 初回ガイド(コーチ)を一度だけ表示（ローカル/中継版。localStorage/showModal はブラウザのみ＝try/catch）。
if (!globalThis.__BUDDYFIGHT_THIN__ && !globalThis.__BUDDYFIGHT_SERVER__) {
  try {
    const coach = document.querySelector("#coachDialog");
    if (coach) {
      document.querySelector("#coachCloseButton")?.addEventListener("click", () => coach.close());
      if (coach.showModal && !localStorage.getItem("bf_coach_seen")) {
        coach.showModal();
        localStorage.setItem("bf_coach_seen", "1");
      }
    }
  } catch {
    /* localStorage 不可環境は無視 */
  }
}
elements.confirmOkButton?.addEventListener("click", () => resolveConfirmDialog(true));
elements.confirmCancelButton?.addEventListener("click", () => resolveConfirmDialog(false));
elements.confirmDialog?.addEventListener("cancel", (event) => {
  event.preventDefault(); // ESC＝キャンセル扱い
  resolveConfirmDialog(false);
});

if (globalThis.__BUDDYFIGHT_SERVER__) {
  // 権威サーバ駆動用フック（サーバでのみ有効。ブラウザ/テストの挙動は不変）。
  // サーバは elements スタブに値をセット＋setSelected で選択を与えてから actions を呼ぶ。
  globalThis.__buddyfightServerApi = {
    loadGameData,
    newGame,
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    getDeckProfiles: () => deckProfiles,
    elements,
    applyDeckValues,
    setSelected: (selection) => {
      state.selected = selection ?? null;
    },
    setLinkAttackers: (slots) => {
      state.linkAttackers = slots ?? [];
    },
    actions: {
      drawAction,
      chargeAction,
      goMainPhase,
      goAttackPhase,
      goFinalPhase,
      callMonster,
      useCardAction,
      attackAction,
      endTurn,
      partnerCall,
      toggleLinkAttacker,
      resolvePendingResolution,
      toggleCounterHand,
    },
  };
} else if (globalThis.__BUDDYFIGHT_TEST__) {
  globalThis.__buddyfightTestApi = {
    adjustedCostSteps,
    adjustedLegacyCost,
    applyAttackRedirectContinuous,
    applyDamageToPlayer,
    applyLifeLink,
    applicableAttackResistances,
    attackSourceResisted,
    callMonster,
    canDeclareAttack,
    checkAbilityConditions,
    clearTurnModifiers,
    createInstanceId,
    effectiveSize,
    equipCardDirect,
    equippedItems,
    findUsableDropAbilities,
    useDropAbilityAction,
    getFieldSize,
    standPlayer,
    visiblePower,
    destroyFieldCard,
    executeAbilityBody,
    hasKeyword,
    findUsableHandAbility,
    findUsableFieldAbilities,
    isAbilitiesNullified,
    visibleCritical,
    visibleDefense,
    runTriggeredAbilities,
    runFieldEventTriggers,
    runPhaseStartTriggers,
    checkCondition,
    getState: () => state,
    legacyAbilityScriptDefinition,
    selectedCounterKind,
    canUseCounterEffect,
    markCounterUsed,
    isRepeatableCounterKind,
    executeAbilityEffect,
    returnFieldTargetToHand,
    getPendingAttackers,
    resolveAmountFrom,
    endTurn,
    matchesCardFilter,
    canAttackTargetValue,
    applyAttackTaxes,
    dropOwnMonsterCostCandidates,
    payStructuredCost,
    payStructuredCostWithSelection,
    canPayStructuredCost,
    discardHandCardsToDrop,
    linkAttackDamageCapFor,
    continuousPowerBonus,
    continuousDefenseBonus,
    continuousCriticalBonus,
    normalizeCardDefinition,
    applyNetworkMessage,
    resolveRockPaperScissors,
    resolveOnEnter,
    resolvePendingResolution,
    setState: (nextState) => {
      state = nextState;
    },
    setNetworkSession: (values) => {
      networkSession = {
        ...networkSession,
        ...values,
      };
    },
    useCardAction,
  };
} else {
  initializeApp();
}
} // end: __BUDDYFIGHT_THIN__ else
