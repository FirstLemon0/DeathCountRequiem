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
  zoneButton.addEventListener("click", () => {
    if (suppressNextZoneClick) {
      suppressNextZoneClick = false;
      return; // ロングプレス直後のclickは無視
    }
    const owner = Number(zoneButton.dataset.owner);
    const zone = zoneButton.dataset.zone;
    // 対象選択モード中：候補タップ＝確定、それ以外＝キャンセル
    if (uiTargeting?.mode === "attack") {
      if (isAttackCandidateZone(owner, zone)) {
        confirmAttackTarget(zone);
      } else {
        uiTargeting = null;
        render();
      }
      return;
    }
    if (uiTargeting?.mode === "effect") {
      if (isEffectCandidateZone(owner, zone)) {
        pickEffectTarget(owner, zone);
      } else {
        uiTargeting = null;
        render();
      }
      return;
    }
    // 平時：自分のカードは選択してシート、相手/操作不可は閲覧専用シート
    const card = state.players[owner]?.field?.[zone];
    const selected = selectFieldCard(owner, zone);
    if (selected) {
      openCardSheet();
    } else if (card) {
      openReadOnlyCardSheet(card);
    } else {
      // 空きフィールドのタップ: 置き方が分からず迷う人向けに導線を一言ヒント。
      showToast("手札のカードをタップ→「コール先」で配置できます");
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
    // バディコール（実コール）は不可逆なので確認を1枚挟む
    const card = getSelectedCard();
    const buddyDeclared = Boolean(
      state?.buddyCallDeclared && state.buddyCallDeclared === card?.instanceId,
    );
    if (buddyDeclared && !(await confirmAction(`${card.name}をバディコールしますか？`))) {
      return;
    }
    await runNetworkMutation("コール", () => callMonster(button.dataset.callZone));
  });
});

// B2: ワールドタイル → デッキ情報ポップアップ
document.querySelectorAll(".buddy-cell").forEach((tile) => {
  tile.addEventListener("click", () => {
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
elements.endTurnButton.addEventListener("click", async () => {
  // B2: 不可逆なので確認を1枚挟む
  if (!(await confirmAction("ターンを終了しますか？"))) {
    return;
  }
  await runNetworkMutation("ターン終了", endTurn);
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
    applyAttackRedirectContinuous,
    applyDamageToPlayer,
    applicableAttackResistances,
    callMonster,
    canDeclareAttack,
    checkAbilityConditions,
    createInstanceId,
    visiblePower,
    destroyFieldCard,
    executeAbilityBody,
    hasKeyword,
    findUsableHandAbility,
    getState: () => state,
    legacyAbilityScriptDefinition,
    selectedCounterKind,
    canUseCounterEffect,
    markCounterUsed,
    isRepeatableCounterKind,
    executeAbilityEffect,
    matchesCardFilter,
    canAttackTargetValue,
    applyAttackTaxes,
    dropOwnMonsterCostCandidates,
    payStructuredCost,
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
