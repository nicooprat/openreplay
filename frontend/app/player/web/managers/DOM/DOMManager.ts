import logger from 'App/logger';

import type Screen from '../../Screen/Screen';
import type { Message, SetNodeScroll } from '../../messages';
import { MType } from '../../messages';
import ListWalker from '../../../common/ListWalker';
import StylesManager from './StylesManager';
import FocusManager from './FocusManager';
import SelectionManager from './SelectionManager';
import type { StyleElement } from './VirtualDOM';
import {
  PostponedStyleSheet,
  VDocument,
  VElement,
  VHTMLElement,
  VNode,
  VShadowRoot,
  VText,
} from './VirtualDOM';
import { deleteRule, insertRule } from './safeCSSRules';

type HTMLElementWithValue = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const IGNORED_ATTRS = [ "autocomplete" ];
const ATTR_NAME_REGEXP = /([^\t\n\f \/>"'=]+)/; // regexp costs ~

export default class DOMManager extends ListWalker<Message> {
  private readonly vTexts: Map<number, VText> = new Map() // map vs object here?
  private readonly vElements: Map<number, VElement> = new Map()
  private readonly vRoots: Map<number, VShadowRoot | VDocument> = new Map()
  private styleSheets: Map<number, CSSStyleSheet> = new Map()
  private ppStyleSheets: Map<number, PostponedStyleSheet> = new Map()
  /** @depreacted since tracker 4.0.2 Mapping by nodeID */
  private ppStyleSheetsDeprecated: Map<number, PostponedStyleSheet> = new Map() 
  private stringDict: Record<number,string> = {}
  private attrsBacktrack: Message[] = []

  private upperBodyId: number = -1;
  private nodeScrollManagers: Map<number, ListWalker<SetNodeScroll>> = new Map()
  private stylesManager: StylesManager
  private focusManager: FocusManager = new FocusManager(this.vElements)
  private selectionManager: SelectionManager

  constructor(
    private readonly screen: Screen,
    private readonly isMobile: boolean,
    public readonly time: number,
    setCssLoading: ConstructorParameters<typeof StylesManager>[1],
  ) {
    super()
    this.selectionManager = new SelectionManager(this.vElements, screen)
    this.stylesManager = new StylesManager(screen, setCssLoading)
  }

  append(m: Message): void {
    if (m.tp === MType.SetNodeScroll) {
      let scrollManager = this.nodeScrollManagers.get(m.id)
      if (!scrollManager) {
        scrollManager = new ListWalker()
        this.nodeScrollManagers.set(m.id, scrollManager)
      }
      scrollManager.append(m)
      return
    }
    if (m.tp === MType.SetNodeFocus) {
      this.focusManager.append(m)
      return
    }
    if (m.tp === MType.SelectionChange) {
      this.selectionManager.append(m)
      return
    }
    if (m.tp === MType.CreateElementNode) {
      if(m.tag === "BODY" && this.upperBodyId === -1) {
        this.upperBodyId = m.id
      }
    } else if (m.tp === MType.SetNodeAttribute &&
      (IGNORED_ATTRS.includes(m.name) || !ATTR_NAME_REGEXP.test(m.name))) {
      logger.log("Ignorring message: ", m)
      return; // Ignoring
    }
    super.append(m)
  }

  private removeBodyScroll(id: number, vElem: VElement): void {
    if (this.isMobile && this.upperBodyId === id) { // Need more type safety!
      (vElem.node as HTMLBodyElement).style.overflow = "hidden"
    }
  }

  private removeAutocomplete(vElem: VElement): boolean {
    const tag = vElem.tagName
    if ([ "FORM", "TEXTAREA", "SELECT" ].includes(tag)) {
      vElem.setAttribute("autocomplete", "off");
      return true;
    }
    if (tag === "INPUT") {
      vElem.setAttribute("autocomplete", "new-password");
      return true;
    }
    return false;
  }

  private insertNode({ parentID, id, index }: { parentID: number, id: number, index: number }): void {
    const child = this.vElements.get(id) || this.vTexts.get(id)
    if (!child) {
      logger.error("Insert error. Node not found", id);
      return;
    }
    const parent = this.vElements.get(parentID) || this.vRoots.get(parentID)
    if (!parent) {
      logger.error("Insert error. Parent node not found", parentID, this.vElements, this.vRoots);
      return;
    }

    const pNode = parent.node // TODOTODO
    if ((pNode instanceof HTMLStyleElement) &&  // TODO: correct ordering OR filter in tracker
        pNode.sheet &&
        pNode.sheet.cssRules &&
        pNode.sheet.cssRules.length > 0 &&
        pNode.innerText &&
        pNode.innerText.trim().length === 0
    ) {
      logger.log("Trying to insert child to a style tag with virtual rules: ", parent, child);
      return;
    }

    parent.insertChildAt(child, index)
  }

  private setNodeAttribute(msg: { id: number, name: string, value: string }) {
    let { name, value } = msg;
    const vn = this.vElements.get(msg.id)
    if (!vn) { logger.error("SetNodeAttribute: Node not found", msg); return }

    if (vn.tagName === "INPUT" && name === "name") {
      // Otherwise binds local autocomplete values (maybe should ignore on the tracker level)
      return
    }
    if (name === "href" && vn.tagName === "LINK") {
      // @ts-ignore  ?global ENV type   // It've been done on backend (remove after testing in saas)
      // if (value.startsWith(window.env.ASSETS_HOST || window.location.origin + '/assets')) {
      //   value = value.replace("?", "%3F");
      // }
      if (!value.startsWith("http")) {
        return
      }
      // blob:... value can happen here for some reason.
      // which will result in that link being unable to load and having 4sec timeout in the below function.

      // TODO: check if node actually exists on the page, not just in memory
      this.stylesManager.setStyleHandlers(vn.node as HTMLLinkElement, value);
    }
    if (vn.isSVG && value.startsWith("url(")) {
      value = "url(#" + (value.split("#")[1] ||")")
    }
    vn.setAttribute(name, value)
    this.removeBodyScroll(msg.id, vn)
  }

  private applyMessage = (msg: Message): Promise<any> | undefined => {
    switch (msg.tp) {
      case MType.CreateDocument: {
        const doc = this.screen.document;
        if (!doc) {
          logger.error("No root iframe document found", msg, this.screen)
          return;
        }
        doc.open();
        doc.write("<!DOCTYPE html><html></html>");
        doc.close();
        const fRoot = doc.documentElement;
        fRoot.innerText = '';

        const vHTMLElement = new VHTMLElement(fRoot)
        this.vElements.clear()
        this.vElements.set(0, vHTMLElement)
        const vDoc = new VDocument(() => doc as Document)
        vDoc.insertChildAt(vHTMLElement, 0)
        this.vRoots.clear()
        this.vRoots.set(0, vDoc) // watchout: id==0 for both Document and documentElement
        // this is done for the AdoptedCSS logic
        // todo: start from 0-node (sync logic with tracker)
        this.vTexts.clear()
        this.stylesManager.reset()
        this.stringDict = {}
        return
      }
      case MType.CreateTextNode: {
        const vText = new VText()
        this.vTexts.set(msg.id, vText)
        this.insertNode(msg)
        return
      }
      case MType.CreateElementNode: {
        const vElem = new VElement(msg.tag, msg.svg)
        this.vElements.set(msg.id, vElem)
        this.insertNode(msg)
        this.removeBodyScroll(msg.id, vElem)
        this.removeAutocomplete(vElem)
        if (['STYLE', 'style', 'LINK'].includes(msg.tag)) { // Styles in priority
          vElem.enforceInsertion()
        }
        return
      }
      case MType.MoveNode:
        this.insertNode(msg)
        return
      case MType.RemoveNode: {
        const vChild = this.vElements.get(msg.id) || this.vTexts.get(msg.id)
        if (!vChild) { logger.error("RemoveNode: Node not found", msg); return }
        if (!vChild.parentNode) { logger.error("RemoveNode: Parent node not found", msg); return }
        vChild.parentNode.removeChild(vChild)
        this.vElements.delete(msg.id)
        this.vTexts.delete(msg.id)
        return
      }
      case MType.SetNodeAttribute:
        if (msg.name === 'href') this.attrsBacktrack.push(msg)
        else this.setNodeAttribute(msg)
        return
      case MType.StringDict:
        this.stringDict[msg.key] = msg.value
        return
      case MType.SetNodeAttributeDict:
        this.stringDict[msg.nameKey] === undefined && logger.error("No dictionary key for msg 'name': ", msg)
        this.stringDict[msg.valueKey] === undefined && logger.error("No dictionary key for msg 'value': ", msg)
        if (this.stringDict[msg.nameKey] === undefined || this.stringDict[msg.valueKey] === undefined ) { return }
        if (this.stringDict[msg.nameKey] === 'href') this.attrsBacktrack.push(msg)
        else {
          this.setNodeAttribute({
            id: msg.id,
            name: this.stringDict[msg.nameKey],
            value: this.stringDict[msg.valueKey],
          })
        }
        return
      case MType.RemoveNodeAttribute: {
        const vElem = this.vElements.get(msg.id)
        if (!vElem) { logger.error("RemoveNodeAttribute: Node not found", msg); return }
        vElem.removeAttribute(msg.name)
        return
      }
      case MType.SetInputValue: {
        const vElem = this.vElements.get(msg.id)
        if (!vElem) { logger.error("SetInoputValue: Node not found", msg); return }
        const nodeWithValue = vElem.node
        if (!(nodeWithValue instanceof HTMLInputElement
            || nodeWithValue instanceof HTMLTextAreaElement
            || nodeWithValue instanceof HTMLSelectElement)
        ) {
          logger.error("Trying to set value of non-Input element", msg)
          return
        }
        const val = msg.mask > 0 ? '*'.repeat(msg.mask) : msg.value
        const doc = this.screen.document
        if (doc && nodeWithValue === doc.activeElement) {
          // For the case of Remote Control
          nodeWithValue.onblur = () => { nodeWithValue.value = val }
          return
        }
        nodeWithValue.value = val // Maybe make special VInputValueElement type for lazy value update
        return
      }
      case MType.SetInputChecked: {
        const vElem = this.vElements.get(msg.id)
        if (!vElem) { logger.error("SetInputChecked: Node not found", msg); return }
        (vElem.node as HTMLInputElement).checked = msg.checked // Maybe make special VCheckableElement type for lazy checking
        return
      }
      case MType.SetNodeData:
      case MType.SetCssData: {
        const vText = this.vTexts.get(msg.id)
        if (!vText) { logger.error("SetCssData: Node not found", msg); return }
        vText.setData(msg.data)
       
        if (msg.tp === MType.SetCssData) { //TODOTODO
          vText.applyChanges() // Styles in priority  (do we need inlines as well?)
        }
        return
      }

      /** @deprecated 
       * since 4.0.2 in favor of AdoptedSsInsertRule/DeleteRule + AdoptedSsAddOwner as a common case for StyleSheets
       */
      case MType.CssInsertRule: {
        let styleSheet = this.ppStyleSheetsDeprecated.get(msg.id)
        if (!styleSheet) {
          const vElem = this.vElements.get(msg.id)
          if (!vElem) { logger.error("CssInsertRule: Node not found", msg); return }
          if (vElem.tagName.toLowerCase() !== "style") { logger.error("CssInsertRule: Non-style elemtn", msg); return }
          styleSheet = new PostponedStyleSheet(vElem.node as StyleElement)
          this.ppStyleSheetsDeprecated.set(msg.id, styleSheet)
        }
        styleSheet.insertRule(msg.rule, msg.index)
        return
      }
      case MType.CssDeleteRule: {
        const styleSheet = this.ppStyleSheetsDeprecated.get(msg.id)
        if (!styleSheet) { logger.error("CssDeleteRule: StyleSheet was not created", msg); return }
        styleSheet.deleteRule(msg.index)
        return
      }
      /* end @deprecated */
      case MType.CreateIFrameDocument: {
        const vElem = this.vElements.get(msg.frameID)
        if (!vElem) { logger.error("CreateIFrameDocument: Node not found", msg); return }
        vElem.enforceInsertion() //TODOTODO
        const host = vElem.node
        if (host instanceof HTMLIFrameElement) {
          const doc = host.contentDocument
          if (!doc) {
            logger.warn("No default iframe doc", msg, host)
            return
          }

          const vDoc = new VDocument(() => doc)
          this.vRoots.set(msg.id, vDoc)
          return;
        } else if (host instanceof Element) { // shadow DOM
          try {
            const shadowRoot = host.attachShadow({ mode: 'open' })
            const vRoot = new VShadowRoot(() => shadowRoot)
            this.vRoots.set(msg.id, vRoot)
          } catch(e) {
            logger.warn("Can not attach shadow dom", e, msg)
          }
        } else {
          logger.warn("Context message host is not Element", msg)
        }
        return
      }
      case MType.AdoptedSsInsertRule: {
        const styleSheet = this.styleSheets.get(msg.sheetID) || this.ppStyleSheets.get(msg.sheetID)
        if (!styleSheet) {
          logger.warn("No stylesheet was created for ", msg)
          return
        }
        insertRule(styleSheet, msg)
        return
      }
      case MType.AdoptedSsDeleteRule: {
        const styleSheet = this.styleSheets.get(msg.sheetID) || this.ppStyleSheets.get(msg.sheetID)
        if (!styleSheet) {
          logger.warn("No stylesheet was created for ", msg)
          return
        }
        deleteRule(styleSheet, msg)
        return
      }
      case MType.AdoptedSsReplace: {
        const styleSheet = this.styleSheets.get(msg.sheetID)
        if (!styleSheet) {
          logger.warn("No stylesheet was created for ", msg)
          return
        }
        // @ts-ignore
        styleSheet.replaceSync(msg.text)
        return
      }
      case MType.AdoptedSsAddOwner: {
        const vRoot = this.vRoots.get(msg.id)
        if (!vRoot) {
          /* <style> tag case */
          const vElem = this.vElements.get(msg.id)
          if (!vElem) { logger.error("AdoptedSsAddOwner: Node not found", msg); return }
          if (vElem.tagName.toLowerCase() !== "style") { logger.error("Non-style owner", msg); return }
          this.ppStyleSheets.set(msg.sheetID, new PostponedStyleSheet(vElem.node as StyleElement))
          return
        }
        /* Constructed StyleSheet case */
        let styleSheet = this.styleSheets.get(msg.sheetID)
        if (!styleSheet) {
          let context: typeof globalThis | null
          if (vRoot instanceof VDocument) {
            context = vRoot.node.defaultView
          } else {
            context = vRoot.node.ownerDocument.defaultView
          }
          if (!context) { logger.error("AdoptedSsAddOwner: Root node default view not found", msg); return }
          styleSheet = new context.CSSStyleSheet() /* a StyleSheet from another Window context won't work */
          this.styleSheets.set(msg.sheetID, styleSheet)
        }
        // @ts-ignore
        vRoot.node.adoptedStyleSheets = [...vRoot.node.adoptedStyleSheets, styleSheet]
        return
      }
      case MType.AdoptedSsRemoveOwner: {
        const styleSheet = this.styleSheets.get(msg.sheetID)
        if (!styleSheet) {
          logger.warn("No stylesheet was created for ", msg)
          return
        }
        const vRoot = this.vRoots.get(msg.id)
        if (!vRoot) { logger.error("AdoptedSsRemoveOwner: Node not found", msg); return }
        //@ts-ignore
        vRoot.node.adoptedStyleSheets = [...vRoot.node.adoptedStyleSheets].filter(s => s !== styleSheet)
        return
      }
      case MType.LoadFontFace: {
        const vRoot = this.vRoots.get(msg.parentID)
        if (!vRoot) { logger.error("LoadFontFace: Node not found", msg); return }
        if (vRoot instanceof VShadowRoot) { logger.error(`Node ${vRoot} expected to be a Document`, msg); return }
        let descr: Object | undefined
        try {
          descr = JSON.parse(msg.descriptors)
          descr = typeof descr === 'object' ? descr : undefined
        } catch {
          logger.warn("Can't parse font-face descriptors: ", msg)
        }
        const ff = new FontFace(msg.family, msg.source, descr)
        vRoot.node.fonts.add(ff)
        return ff.load()
      }
    }
  }

  applyBacktrack(msg: Message) {
    // @ts-ignore
    const target = this.vElements.get(msg.id)
    if (!target) {
      return
    }

    switch (msg.tp) {
      case MType.SetNodeAttribute: {
        this.setNodeAttribute(msg)
        return
      }
      case MType.SetNodeAttributeDict: {
        this.stringDict[msg.nameKey] === undefined && logger.error("No dictionary key for msg 'name': ", msg)
        this.stringDict[msg.valueKey] === undefined && logger.error("No dictionary key for msg 'value': ", msg)
        if (this.stringDict[msg.nameKey] === undefined || this.stringDict[msg.valueKey] === undefined) {
          return
        }
        this.setNodeAttribute({
          id: msg.id,
          name: this.stringDict[msg.nameKey],
          value: this.stringDict[msg.valueKey],
        })
        return;
      }
    }
  }

  async moveReady(t: number): Promise<void> {
    // MBTODO (back jump optimisation):
    //    - store intemediate virtual dom state
    //    - cancel previous moveReady tasks (is it possible?) if new timestamp is less
    // This function autoresets pointer if necessary (better name?)

    /**
     * Basically just skipping all set attribute with attrs being "href" if user is 'jumping'
     * to the other point of replay to save time on NOT downloading any resources before the dom tree changes
     * are applied, so it won't try to download and then cancel when node is created in msg N and removed in msg N+2
     * which produces weird bug when asset is cached (10-25ms delay)
     * */
    // http://0.0.0.0:3333/5/session/8452905874437457
    // 70 iframe, 8 create element - STYLE tag
    await this.moveWait(t, this.applyMessage)

    this.attrsBacktrack.forEach(msg => {
      this.applyBacktrack(msg)
    })
    this.attrsBacktrack = []

    this.vRoots.forEach(rt => rt.applyChanges()) // MBTODO (optimisation): affected set
    // Thinkabout (read): css preload
    // What if we go back before it is ready? We'll have two handlres?
    return this.stylesManager.moveReady(t).then(() => {
      // Apply focus
      this.focusManager.move(t)
      this.selectionManager.move(t)
      // Apply all scrolls after the styles got applied
      this.nodeScrollManagers.forEach(manager => {
        const msg = manager.moveGetLast(t)
        if (msg) {
          let vNode: VElement | VDocument | VShadowRoot | undefined
          if (vNode = this.vElements.get(msg.id)) {
            vNode.node.scrollLeft = msg.x
            vNode.node.scrollTop = msg.y
          } else if ((vNode = this.vRoots.get(msg.id)) && vNode instanceof VDocument){
            vNode.node.defaultView?.scrollTo(msg.x, msg.y)
          }
        }
      })
    })
  }
}
