// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState} from 'react';
import {Modal} from 'react-bootstrap';
import {useDispatch, useSelector} from 'react-redux';

import {closeModal} from 'actions/views/modals';
import {ModalIdentifiers} from 'utils/constants';
import {isModalOpen} from 'selectors/views/modals';
import {GlobalState} from 'types/store';
import {isCurrentLicenseCloud} from 'mattermost-redux/selectors/entities/cloud';

import Content from './content';
import SelfHostedContent from './self_hosted_content';

import './pricing_modal.scss';

function PricingModal() {
    const [showModal, setShowModal] = useState(true);
    const dispatch = useDispatch();
    const isCloud = useSelector(isCurrentLicenseCloud);
    const isCloudPurchaseModalOpen = useSelector((state: GlobalState) => isModalOpen(state, ModalIdentifiers.CLOUD_PURCHASE));

    const onHide = () => {
        // this fixes problem when both pricing modal and purchase modal are open and subsequently, when a user closes the pricing modal,
        // the purchase modal becomes unresponsive for sometime because the pricing modal is still in the DOM.
        if (isCloudPurchaseModalOpen) {
            dispatch(closeModal(ModalIdentifiers.PRICING_MODAL));
        } else {
            setShowModal(false);
        }
    };

    const content = isCloud ? (
        <Content
            onHide={onHide}
        />
    ) : (
        <SelfHostedContent
            onHide={onHide}
        />
    );

    return (
        <Modal
            className='PricingModal'
            show={showModal}
            id='pricingModal'
            onExited={() => {
                dispatch(closeModal(ModalIdentifiers.PRICING_MODAL));
            }}
            data-testid='pricingModal'
            dialogClassName='a11y__modal'
            onHide={onHide}
            role='dialog'
            aria-modal='true'
            aria-labelledby='pricing_modal_title'
        >
            {content}

        </Modal>
    );
}

export default PricingModal;
