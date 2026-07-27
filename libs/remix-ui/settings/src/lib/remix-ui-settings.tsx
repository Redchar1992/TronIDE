/*
 * Original work Copyright © 2018-2021 Remix Team
 * Licensed under the MIT License.
 *
 * Modifications Copyright © 2022 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState, useReducer, useEffect } from 'react' // eslint-disable-line

import { enablePersonalModeText, ethereunVMText, generateContractMetadataText, matomoAnalytics, textDark, textSecondary, warnText, wordWrapText } from './constants'

import './remix-ui-settings.css'
import { ethereumVM, generateContractMetadat, personal, textWrapEventAction, useMatomoAnalytics } from './settingsAction'
import { initialState, settingReducer } from './settingsReducer'

/* eslint-disable-next-line */
export interface RemixUiSettingsProps {
  config: any,
  editor: any,
   _deps: any,
   useMatomoAnalytics: boolean
}

export const RemixUiSettings = (props: RemixUiSettingsProps) => {
  const [, dispatch] = useReducer(settingReducer, initialState)
  const [themeName, setThemeName] = useState('')

  useEffect(() => {
    props._deps.themeModule.switchTheme()
    // First run: default contract-metadata generation to on. (This used to be
    // keyed on the legacy Settings gist token being undefined; that PAT channel
    // is retired, so the setting now keys off its own absence.)
    if (props.config.get('settings/generate-contract-metadata') === undefined) {
      props.config.set('settings/generate-contract-metadata', true)
      dispatch({ type: 'contractMetadata', payload: { name: 'contractMetadata', isChecked: true, textClass: textDark } })
    }
  }, [themeName])

  useEffect(() => {
    if (props.useMatomoAnalytics !== null) useMatomoAnalytics(props.config, props.useMatomoAnalytics, dispatch)
  }, [props.useMatomoAnalytics])

  useEffect(() => {
    const javascriptVM = props.config.get('settings/always-use-vm')

    if ((javascriptVM === null) || (javascriptVM === undefined)) ethereumVM(props.config, true, dispatch)
  }, [props.config])

  const onchangeGenerateContractMetadata = (event) => {
    generateContractMetadat(props.config, event.target.checked, dispatch)
  }

  const onchangeOption = (event) => {
    ethereumVM(props.config, event.target.checked, dispatch)
  }

  const textWrapEvent = (event) => {
    textWrapEventAction(props.config, props.editor, event.target.checked, dispatch)
  }

  const onchangePersonal = event => {
    personal(props.config, event.target.checked, dispatch)
  }

  const onchangeMatomoAnalytics = event => {
    useMatomoAnalytics(props.config, event.target.checked, dispatch)
  }

  const onswitchTheme = (event, name) => {
    props._deps.themeModule.switchTheme(name)
    setThemeName(name)
  }

  const getTextClass = (key) => {
    if (props.config.get(key)) {
      return textDark
    } else {
      return textSecondary
    }
  }

  const generalConfig = () => {
    const isMetadataChecked = props.config.get('settings/generate-contract-metadata') || false
    const isEthereumVMChecked = props.config.get('settings/always-use-vm') || false
    const isEditorWrapChecked = props.config.get('settings/text-wrap') || false
    const isPersonalChecked = props.config.get('settings/personal-mode') || false
    const isMatomoChecked = props.config.get('settings/matomo-analytics') || false

    return (
      <div className="$border-top">
        <div className="card-body pt-3 pb-2">
          <h6 className="card-title">General settings</h6>
          <div className="mt-2 custom-control custom-checkbox mb-1">
            <input onChange={onchangeGenerateContractMetadata} id="generatecontractmetadata" data-id="settingsTabGenerateContractMetadata" type="checkbox" className="custom-control-input" name="contractMetadata" checked = { isMetadataChecked }/>
            <label className={`form-check-label custom-control-label align-middle ${getTextClass('settings/generate-contract-metadata')}`} data-id="settingsTabGenerateContractMetadataLabel" htmlFor="generatecontractmetadata">{generateContractMetadataText}</label>
          </div>
          <div className="fmt-2 custom-control custom-checkbox mb-1">
            <input onChange={onchangeOption} className="custom-control-input" id="alwaysUseVM" data-id="settingsTabAlwaysUseVM" type="checkbox" name="ethereumVM" checked={ isEthereumVMChecked }/>
            <label className={`form-check-label custom-control-label align-middle ${getTextClass('settings/always-use-vm')}`} htmlFor="alwaysUseVM">{ethereunVMText}</label>
          </div>
          <div className="mt-2 custom-control custom-checkbox mb-1">
            <input id="editorWrap" className="custom-control-input" type="checkbox" onChange={textWrapEvent} checked = { isEditorWrapChecked }/>
            <label className={`form-check-label custom-control-label align-middle ${getTextClass('settings/text-wrap')}`} htmlFor="editorWrap">{wordWrapText}</label>
          </div>
        </div>
      </div>
    )
  }

  const themes = () => {
    const themes = props._deps.themeModule.getThemes()
    if (themes) {
      return themes.map((aTheme, index) => (
        <div className="radio custom-control custom-radio mb-1 form-check" key={index}>
          <input type="radio" onChange={event => { onswitchTheme(event, aTheme.name) }} className="align-middle custom-control-input" name='theme' id={aTheme.name} data-id={`settingsTabTheme${aTheme.name}`} checked = {props._deps.themeModule.active === aTheme.name }/>
          <label className="form-check-label custom-control-label" data-id={`settingsTabThemeLabel${aTheme.name}`} htmlFor={aTheme.name}>{aTheme.name} ({aTheme.quality})</label>
        </div>
      )
      )
    }
  }

  return (
    <div>
      {generalConfig()}
      <div className="border-top">
        <div className="card-body pt-3 pb-2">
          <h6 className="card-title">Theme</h6>
          <div className="card-text themes-container" data-id="settingsTabThemePanel">
            {themes()}
          </div>
        </div>
      </div>
    </div>
  )
}
