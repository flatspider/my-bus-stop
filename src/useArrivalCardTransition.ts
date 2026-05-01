import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import type { ArrivalCardItem } from './arrivalCards'

const EXIT_MS = 320
const SLIDE_MS = 300

interface TransitionState {
  displayCards: ArrivalCardItem[]
  exitingTopId: string | null
  isSlidePhase: boolean
  resetKey?: string
}

type TransitionAction =
  | { type: 'replace'; cards: ArrivalCardItem[]; resetKey?: string }
  | { type: 'start-exit'; topId: string }
  | { type: 'begin-slide'; cards: ArrivalCardItem[]; resetKey?: string }
  | { type: 'end-slide' }

function reducer(state: TransitionState, action: TransitionAction): TransitionState {
  switch (action.type) {
    case 'replace':
      return {
        displayCards: action.cards,
        exitingTopId: null,
        isSlidePhase: false,
        resetKey: action.resetKey,
      }
    case 'start-exit':
      return {
        ...state,
        exitingTopId: action.topId,
        isSlidePhase: false,
      }
    case 'begin-slide':
      return {
        displayCards: action.cards,
        exitingTopId: null,
        isSlidePhase: true,
        resetKey: action.resetKey,
      }
    case 'end-slide':
      return {
        ...state,
        isSlidePhase: false,
      }
    default:
      return state
  }
}

export function useArrivalCardTransition(
  cards: ArrivalCardItem[],
  shouldAnimate: boolean,
  resetKey?: string,
): TransitionState {
  const [state, dispatch] = useReducer(reducer, {
    displayCards: cards,
    exitingTopId: null,
    isSlidePhase: false,
    resetKey,
  })

  const exitTimerRef = useRef<number | null>(null)
  const slideTimerRef = useRef<number | null>(null)
  const resetKeyChanged = state.resetKey !== resetKey

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
      }
      if (slideTimerRef.current !== null) {
        window.clearTimeout(slideTimerRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
    if (slideTimerRef.current !== null) {
      window.clearTimeout(slideTimerRef.current)
      slideTimerRef.current = null
    }

    if (resetKeyChanged) {
      dispatch({ type: 'replace', cards, resetKey })
      return
    }

    if (!shouldAnimate) {
      dispatch({ type: 'replace', cards, resetKey })
      return
    }

    const previousTop = state.displayCards[0]
    if (!previousTop) {
      dispatch({ type: 'replace', cards, resetKey })
      return
    }

    const topStillPresent = cards.some((card) => card.id === previousTop.id)
    if (topStillPresent) {
      dispatch({ type: 'replace', cards, resetKey })
      return
    }

    dispatch({ type: 'start-exit', topId: previousTop.id })

    exitTimerRef.current = window.setTimeout(() => {
      dispatch({ type: 'begin-slide', cards, resetKey })

      slideTimerRef.current = window.setTimeout(() => {
        dispatch({ type: 'end-slide' })
      }, SLIDE_MS)
    }, EXIT_MS)
  }, [cards, resetKey, resetKeyChanged, shouldAnimate, state.displayCards])

  if (resetKeyChanged) {
    return {
      displayCards: cards,
      exitingTopId: null,
      isSlidePhase: false,
      resetKey,
    }
  }

  return state
}
